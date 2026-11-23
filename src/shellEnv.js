'use strict';

/*
 * Shell environment for runCommand on Windows 7 (Node 16, zero deps).
 *
 * Why this module exists (background: "AI agents fail at Windows shells"):
 * Training data for code models is dominated by bash, so models routinely
 * emit bash/POSIX syntax ($env:VAR is the least surprising failure is really
 * the reverse: export/dir confusion). The blog-era consensus is: give the
 * agent a bash-compatible shell when possible, and ALWAYS inject explicit
 * shell-syntax rules into the system prompt — prompt rules are the only
 * channel the model cannot bypass.
 *
 * Win7 reality check (differs from Win10/11 advice):
 *  - WSL is impossible on Win7. Not offered.
 *  - PowerShell 7.2 is the last pwsh that runs on Win7, but offline machines
 *    rarely have it; we target the stock Windows PowerShell 5.1 and teach the
 *    model its quirks (no &&, ; chaining, $env: vars) instead.
 *  - Git for Windows 2.46.2 is the last release that supports Win7;
 *    when its bash.exe is present we offer shell:"bash" and recommend it
 *    as the default (auto mode), because bash is the model's native tongue.
 *
 * Everything here is pure logic or cheap cached detection, so it can be
 * unit-tested offline (see scripts/audit.js).
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const SHELL_KEYS = ['powershell', 'cmd', 'bash'];

/* Human-readable names for dialogs and status lines. */
function shellLabel(shell) {
  if (shell === 'cmd') { return 'CMD'; }
  if (shell === 'bash') { return 'Git Bash'; }
  return 'PowerShell';
}

/* ---- bash.exe detection (cached; call resetBashCache in tests) ---- */

let bashPathCache = null;

function resetBashCache() { bashPathCache = null; }

function findBashPath() {
  /* 1) `where bash.exe`. On Win7 there is no System32\bash (WSL), but filter
   * it anyway so this stays correct if run on newer Windows too. */
  try {
    const r = cp.spawnSync('where', ['bash.exe'], {
      windowsHide: true, shell: false, encoding: 'utf8', timeout: 3000
    });
    if (r.status === 0 && r.stdout) {
      const lines = String(r.stdout).split(/\r?\n/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s && !/System32/i.test(s); });
      if (lines.length) { return lines[0]; }
    }
  } catch (e) { /* where missing or blocked -> fall through */ }
  /* 2) Standard Git for Windows install locations (2.46.2 = last Win7 release). */
  const bases = [];
  if (process.env.ProgramFiles) { bases.push(process.env.ProgramFiles); }
  if (process.env['ProgramFiles(x86)']) { bases.push(process.env['ProgramFiles(x86)']); }
  if (process.env.LocalAppData) { bases.push(path.join(process.env.LocalAppData, 'Programs')); }
  for (let i = 0; i < bases.length; i++) {
    const candidates = [
      path.join(bases[i], 'Git', 'bin', 'bash.exe'),
      path.join(bases[i], 'Git', 'usr', 'bin', 'bash.exe')
    ];
    for (let j = 0; j < candidates.length; j++) {
      try { if (fs.existsSync(candidates[j])) { return candidates[j]; } } catch (e) { /* ignore */ }
    }
  }
  return '';
}

function bashPath() {
  if (bashPathCache === null) { bashPathCache = findBashPath(); }
  return bashPathCache;
}

function isBashAvailable() { return !!bashPath(); }

/* ---- shell resolution ---- */

/*
 * Pick the shell for one runCommand call.
 *  - An explicit, AVAILABLE args.shell always wins (the model asked for it).
 *  - Otherwise fall back to the user's preferShell setting; "auto" means
 *    bash when Git Bash is installed, else powershell (blog recommendation).
 *  - A requested-but-unavailable shell downgrades with a note so the model
 *    learns why (and the note is fed back in the tool result).
 */
function resolveShell(prefer, requested, bashAvailable) {
  const bash = (bashAvailable === undefined) ? isBashAvailable() : !!bashAvailable;
  const valid = bash ? SHELL_KEYS : ['powershell', 'cmd'];
  let def = String(prefer || 'auto').trim().toLowerCase();
  if (def === 'auto') {
    def = bash ? 'bash' : 'powershell';
  } else if (valid.indexOf(def) === -1) {
    def = 'powershell';
  }
  const req = String(requested || '').trim().toLowerCase();
  if (valid.indexOf(req) !== -1) {
    return { shell: req, note: '' };
  }
  let note = '';
  if (req) {
    note = 'shell "' + req + '" 不可用' +
      (req === 'bash' && !bash ? '（本机未检测到 bash.exe；Git for Windows 2.46.2 是最后支持 Win7 的版本）' : '') +
      '，已改用 ' + def;
  }
  return { shell: def, note: note };
}

/* ---- prompt section (shell-syntax rules injected into the system prompt) ---- */

function shellSyntaxSection(prefer, bashAvailable) {
  const bash = (bashAvailable === undefined) ? isBashAvailable() : !!bashAvailable;
  const available = bash ? SHELL_KEYS : ['powershell', 'cmd'];
  const resolved = resolveShell(prefer, '', bash);
  const lines = [
    '## Shell 执行环境（IMPORTANT：命令语法必须与 args.shell 匹配，NEVER 混用不同 shell 的语法）',
    '- 本机是 Windows 系统。runCommand 的 args.shell 决定命令按哪种语法执行，当前可用：' +
      available.join('、') + '。不写 shell 参数时默认用 ' + resolved.shell + '。'
  ];
  lines.push(
    '- powershell（Windows PowerShell 5.1）：设置环境变量 $env:VAR="值"、读取 $env:VAR；列目录 Get-ChildItem 或 dir；' +
    '串联命令用分号 ;（PS 5.1 不支持 &&）；字符串拼接用单引号；NEVER 用反斜杠转义双引号（写 \\" 会直接语法错误）。'
  );
  lines.push(
    '- cmd：设置环境变量 set VAR=value、读取 %VAR%；列目录 dir；复制用 copy / xcopy / robocopy；' +
    'cmd 里 NEVER 使用 Get-ChildItem、$env:、export 等任何 PowerShell/bash 语法。'
  );
  if (bash) {
    lines.push(
      '- bash（Git Bash）：标准 bash 语法——export VAR=value、$VAR、ls / cp / grep；' +
      'Windows 程序（node、npm、java 等）在 PATH 中可直接调用；路径一律用正斜杠（C:/Users/...）。'
    );
  }
  lines.push(
    '- 通用：路径含空格必须加引号；写文件内容一律用 createFile/saveText 工具，NEVER 用 echo/重定向拼文件；' +
    '命令失败时先完整读报错文本、修正语法再重试，不要原样重发同一条命令。'
  );
  return lines.join('\n');
}

/* ---- failure diagnosis (shell-syntax mismatch hints) ---- */

/*
 * Heuristic: after a FAILED runCommand, look at the command text and the
 * combined output for signatures of "wrong shell dialect" and return a
 * Chinese hint telling the model exactly which syntax to use instead.
 * Pure function; returns '' when nothing matches (real tool failures like
 * exit code 1 from a legit command must not get spurious hints).
 */
function diagnoseMismatch(shell, command, output) {
  const cmdText = String(command || '');
  const out = String(output || '');
  if (!cmdText && !out) { return ''; }
  const hints = [];
  if (shell === 'cmd') {
    if (/\$env:[A-Za-z_]/.test(cmdText)) {
      hints.push('$env: 是 PowerShell 语法，cmd 里设置环境变量用 set VAR=value、读取用 %VAR%');
    } else if (/is not recognized as an internal or external command|不是内部或外部命令/i.test(out) &&
        /\b(Get-(ChildItem|Content|Item)|Copy-Item|Remove-Item|Test-Path|Select-String)\b/.test(cmdText)) {
      hints.push('Get-*/Copy-Item 等 PowerShell cmdlet 在 cmd 里不存在：cmd 用 dir / type / copy / del / findstr 等等价命令，或改用 shell:"powershell"');
    }
    if (/\bexport\s+[A-Za-z_]+=/.test(cmdText)) {
      hints.push('export 是 bash 语法，cmd 里用 set VAR=value');
    }
  } else if (shell === 'powershell') {
    if (/'&&' is not a valid statement separator|token\s+"&&"/i.test(out)) {
      hints.push('Windows PowerShell 5.1 不支持 && 串联：改用分号 ; 或 if ($LASTEXITCODE -eq 0) { ... }，也可换 shell:"cmd"');
    }
    if (/\bexport\s+[A-Za-z_]+=/.test(cmdText) || /The term ['"]export['"]/i.test(out)) {
      hints.push('export 是 bash 语法，PowerShell 里设置环境变量用 $env:VAR="值"');
    } else if (/\bsource\s+\S+/.test(cmdText) || /The term ['"]source['"]/i.test(out)) {
      hints.push('source 是 bash 语法，PowerShell 里加载脚本用 . .\\script.ps1（点号+空格）');
    } else if (/\bunset\s+[A-Za-z_]/.test(cmdText)) {
      hints.push('unset 是 bash 语法，PowerShell 里删除环境变量用 Remove-Item Env:VAR');
    }
  } else if (shell === 'bash') {
    if (/\b(dir|Copy-Item|Get-ChildItem|chcp|robocopy|xcopy)\b[^\n]*: command not found/i.test(out)) {
      hints.push('这是 Git Bash 环境：dir/copy 等是 cmd/PowerShell 命令，改用 ls / cp / rm；设置环境变量用 export VAR=value');
    }
    if (/\$env:[A-Za-z_]/.test(cmdText)) {
      hints.push('$env: 是 PowerShell 语法，bash 里用 export VAR=value（设置）和 $VAR（读取）');
    } else if (/%[A-Za-z_]+%/.test(cmdText)) {
      hints.push('%VAR% 是 cmd 语法，bash 里读取变量用 $VAR');
    }
  }
  return hints.join('；');
}

module.exports = {
  SHELL_KEYS: SHELL_KEYS,
  shellLabel: shellLabel,
  resetBashCache: resetBashCache,
  findBashPath: findBashPath,
  bashPath: bashPath,
  isBashAvailable: isBashAvailable,
  resolveShell: resolveShell,
  shellSyntaxSection: shellSyntaxSection,
  diagnoseMismatch: diagnoseMismatch
};
