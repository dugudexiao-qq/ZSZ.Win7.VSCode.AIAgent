'use strict';

/*
 * Controlled PowerShell / CMD execution for Windows 7 (Node 16).
 *
 * Why it is built this way (the "stuck command" problem):
 *  - NEVER build a shell command line by concatenating user text. spawn() gets
 *    an argv array with shell:false, so ^ & | < > % ! $ ` quotes and spaces in
 *    paths are never re-parsed by a shell.
 *  - PowerShell scripts go through -EncodedCommand (UTF-16LE + base64), so
 *    quotes/backticks/dollar signs cannot break the command line at all.
 *  - stdin is 'ignore' (not 'pipe'): a process that waits for input would
 *    otherwise hang forever. -NonInteractive -NoProfile avoid prompt dialogs.
 *  - Two independent deadlines: wall-clock and "no output for N ms".
 *    Either one kills the WHOLE process tree with taskkill /T /F, because
 *    child.kill() alone leaves cmd.exe grandchildren alive.
 *  - Output is capped, so a runaway process cannot exhaust memory.
 */

const cp = require('child_process');

const DEFAULTS = {
  timeoutMs: 60000,
  idleTimeoutMs: 15000,
  maxOutputBytes: 65536
};

/* Windows PowerShell 5.1 pipes console output in the OEM codepage, which
 * arrives as mojibake in Node's utf8 decoder. Force UTF-8 inside the script
 * itself (it travels safely inside -EncodedCommand, no quoting involved).
 *
 * $ProgressPreference: PS 5.1 serializes progress records into the stderr
 * stream as CLIXML (visible as "#< CLIXML <Objs ...>" in tool output) whenever
 * a cmdlet writes progress — Invoke-WebRequest does this on every download.
 * It is not an error, but it pollutes STDERR, eats the output byte budget and
 * makes downloads several times slower (progress rendering overhead).
 *
 * TLS 1.2: PS 5.1 on Win7/.NET 4.x does not negotiate TLS 1.2 by default, so
 * https requests to Google Fonts etc. fail with "无法创建 SSL/TLS 安全通道".
 * We only ADD Tls12 to the protocol set (-bor), never downgrade. Guarded by
 * try/catch because [Net.SecurityProtocolType]::Tls12 needs .NET 4.5+. */
const UTF8_PRELUDE =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  '$ProgressPreference=\'SilentlyContinue\'; ' +
  'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; } catch { }\n';

/* cmd 侧的等价物：先切 65001 再跑用户命令。 */
const CMD_UTF8_PREFIX = 'chcp 65001>nul&';

function toEncodedCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function fromEncodedCommand(encoded) {
  return Buffer.from(String(encoded), 'base64').toString('utf16le');
}

/* Pure function: safe to unit-test without spawning anything. */
function buildSpawnSpec(params) {
  const p = params || {};
  const shell = p.shell === 'cmd' ? 'cmd' : 'powershell';
  const command = String(p.command === undefined || p.command === null ? '' : p.command);
  if (!command.trim()) { throw new Error('command 不能为空'); }
  if (shell === 'powershell') {
    return {
      file: 'powershell.exe',
      // -ExecutionPolicy Bypass: many corporate Win7 machines run Restricted,
      // which blocks every .ps1 (npm.ps1, yarn.ps1, any user script) with
      // UnauthorizedAccess. It only sets $env:PSExecutionPolicyPreference for
      // this child process: the registry setting and Group Policy are untouched
      // (a domain GPO still wins over this flag). Available since PowerShell 2.0,
      // so it is safe on a stock Win7 SP1.
      args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', toEncodedCommand(UTF8_PRELUDE + command)],
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    };
  }
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // 中文 Win7 的 cmd 默认用 GBK 输出，Node 按 UTF-8 解码后中文文件名全部
    // 变成替换符，模型拿到乱码后无法正确引用文件，后续命令跟着连环失败。
    // PowerShell 侧有 UTF8_PRELUDE；cmd 没有 prelude 的位置，就在命令前挂
    // 一条 chcp 把控制台代码页切到 65001（UTF-8），输出即可被正确解码。
    // 用 & 而不是 &&：chcp 不该拦住用户的命令；紧跟 >nul 隐藏它自己的输出。
    args: ['/d', '/s', '/c', CMD_UTF8_PREFIX + command],
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  };
}

function killTree(child) {
  if (!child || !child.pid) { return; }
  if (process.platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    return;
  }
  try {
    const killer = cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', shell: false
    });
    killer.on('error', function () { try { child.kill(); } catch (e) { /* ignore */ } });
  } catch (e) {
    try { child.kill(); } catch (e2) { /* ignore */ }
  }
}

function describeLimits(limits) {
  const c = Object.assign({}, DEFAULTS, limits || {});
  return '墙钟 ' + Math.round(c.timeoutMs / 1000) + ' s / 无输出 ' +
    Math.round(c.idleTimeoutMs / 1000) + ' s / 输出上限 ' +
    Math.round(c.maxOutputBytes / 1024) + ' KB';
}

function runCommand(params) {
  const p = params || {};
  const limits = Object.assign({}, DEFAULTS, p.limits || {});
  const started = Date.now();
  let spec;
  try {
    spec = buildSpawnSpec(p);
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message, stdout: '', stderr: '', exitCode: null, durationMs: 0 });
  }

  return new Promise(function (resolve) {
    let child;
    try {
      child = cp.spawn(spec.file, spec.args, {
        cwd: p.cwd || undefined,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '', stderr: '', exitCode: null, durationMs: Date.now() - started });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let truncated = false;
    let timedOut = false;
    let stalled = false;
    let cancelled = false;
    let killed = false;
    let idleTimer = null;
    let wallTimer = null;
    let cancelSub = null;

    function cleanup() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (cancelSub && typeof cancelSub.dispose === 'function') { cancelSub.dispose(); }
    }

    function done(extra) {
      if (settled) { return; }
      settled = true;
      cleanup();
      resolve(Object.assign({
        ok: false,
        stdout: stdout,
        stderr: stderr,
        exitCode: null,
        durationMs: Date.now() - started,
        truncated: truncated,
        timedOut: timedOut,
        stalled: stalled,
        cancelled: cancelled
      }, extra || {}));
    }

    function terminate(reason) {
      if (killed || settled) { return; }
      killed = true;
      timedOut = reason === 'wall';
      stalled = reason === 'idle';
      cancelled = reason === 'cancel';
      killTree(child);
      const label = reason === 'wall' ? '总耗时超过 ' + Math.round(limits.timeoutMs / 1000) + ' s'
        : reason === 'idle' ? '连续 ' + Math.round(limits.idleTimeoutMs / 1000) + ' s 无任何输出，判定为无响应'
          : '用户取消';
      done({ ok: false, error: '已终止：' + label });
    }

    function resetIdle() {
      if (idleTimer) { clearTimeout(idleTimer); }
      if (limits.idleTimeoutMs > 0) {
        idleTimer = setTimeout(function () { terminate('idle'); }, limits.idleTimeoutMs);
      }
    }

    function append(streamName, chunk) {
      if (settled) { return; }
      const piece = String(chunk);
      const used = stdout.length + stderr.length;
      if (!truncated && used + piece.length > limits.maxOutputBytes) {
        truncated = true;
      }
      const room = Math.max(0, limits.maxOutputBytes - used);
      if (room > 0) {
        if (streamName === 'out') { stdout += piece.slice(0, room); }
        else { stderr += piece.slice(0, room); }
      }
      resetIdle();
    }

    wallTimer = setTimeout(function () { terminate('wall'); }, limits.timeoutMs);
    resetIdle();

    if (child.stdout) { child.stdout.on('data', function (c) { append('out', c); }); }
    if (child.stderr) { child.stderr.on('data', function (c) { append('err', c); }); }
    child.on('error', function (e) { done({ ok: false, error: e.message }); });
    child.on('close', function (code) {
      done({ ok: code === 0 && !timedOut && !stalled && !cancelled, exitCode: code });
    });

    if (p.token && typeof p.token.onCancellationRequested === 'function') {
      if (p.token.isCancellationRequested) { terminate('cancel'); return; }
      cancelSub = p.token.onCancellationRequested(function () { terminate('cancel'); });
    }
  });
}

module.exports = {
  DEFAULTS: DEFAULTS,
  toEncodedCommand: toEncodedCommand,
  fromEncodedCommand: fromEncodedCommand,
  buildSpawnSpec: buildSpawnSpec,
  describeLimits: describeLimits,
  killTree: killTree,
  runCommand: runCommand
};
