'use strict';

/*
 * Minimal agent loop. The model asks for tools by emitting a plain JSON object
 * (no function-calling / tools parameter), which keeps it compatible with older
 * OpenAI-compatible endpoints that VS Code 1.70-era users are likely to reach.
 *
 * Every tool call passes through rules.checkToolCall() BEFORE the tool function
 * runs. Prompt-level rules are advisory; this gate is the real boundary.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { chatCompletion, classifyError } = require('./llmClient');
const { parseToolCall, parseToolCalls, hasBrokenToolTemplate, extractJsonObjects } = require('./toolProtocol');
const pathUtils = require('./pathUtils');
const rules = require('./rules');
const lessons = require('./lessons');
const fileImport = require('./fileImport');
const shellEnv = require('./shellEnv');
const agentsMdLib = require('./agentsMd');
const proc = require('./processRunner');
const snapLib = require('./snapshots');

const taskCheck = require('./taskCheck');

const MAX_FILE_BYTES = 200 * 1024;
/* How much of ONE tool result reaches the model. 12000 chars was enough to
 * swallow a small model's whole context in two reads; head+tail keeps the
 * shape of a file without starving the conversation. */
const MAX_RESULT_CHARS = 4000;
/* Total budget for the conversation (system prompt excluded). Chinese text is
 * roughly 1 char ~ 1 token, so 8000 chars fits an 8k-token model; raise it for bigger windows. */
const DEFAULT_MAX_CONTEXT_CHARS = 8000;
/* Local pseudo-streaming: replay a finished answer in slices so the user still
 * sees text appear, while the tool loop keeps working. */
const STREAM_CHUNK_CHARS = 24;
const STREAM_CHUNK_DELAY_MS = 12;
const AUTO_RETRY_MAX = 1;
/* Degraded tool-call templates (invoke open tag missing, only a parameter
 * tag and a lone closing tag left) carry no tool name, so they cannot be
 * executed. Instead of dumping the raw template into the chat we feed a
 * format-error notice back to the model — at most twice per run, then the
 * fragments are stripped and whatever prose remains is shown. */
const BROKEN_TEMPLATE_RETRIES = 2;
/* One failed call used to dump the raw exception into the chat: Windows paths,
 * command echoes and node internals all carry newlines, so a single failure
 * became a three-line red block. The model only needs the reason; the user only
 * needs one line. 300 chars is enough to carry a path plus a fix hint. */
const MAX_ERROR_CHARS = 300;
const MAX_WRITE_CHARS = 20000;
const SUBTASK_MAX_DEPTH = 2;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_SUBTASKS = 6;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;
const CONFIRM_TIMEOUT = '__zsz_confirm_timeout__';

function confirmTimeoutMs(config) {
  const n = Number(config && config.confirmTimeoutMs);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIRM_TIMEOUT_MS;
}

/* Race a VS Code modal dialog against a deadline.
 *
 * showWarningMessage() resolves ONLY when a human clicks a button. If the
 * dialog is hidden behind another window, nobody is at the machine, or the
 * host loses focus, that promise never settles and runAgent waits forever.
 * VS Code 1.70 has no API to close a modal programmatically, so on timeout we
 * simply stop waiting: the dialog may stay on screen, but its promise is no
 * longer observed and clicking it later does NOT run the action.
 *
 * The timer is always cleared on a real answer, and a broken/rejected dialog
 * also resolves (to undefined) instead of hanging the whole run. The timeout
 * notice callback is wrapped in try/catch for the same reason. */
function confirmWithTimeout(promise, ms, onTimeout) {
  const waitMs = Number(ms) > 0 ? Number(ms) : DEFAULT_CONFIRM_TIMEOUT_MS;
  return new Promise(function (resolve) {
    let settled = false;
    let timer = null;
    function finish(value, timedOut) {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (timedOut && typeof onTimeout === 'function') {
        try { onTimeout(); } catch (e) { /* a broken notice must not hang the run */ }
      }
      resolve(value);
    }
    timer = setTimeout(function () { finish(CONFIRM_TIMEOUT, true); }, waitMs);
    Promise.resolve(promise).then(
      function (value) { finish(value, false); },
      function () { finish(undefined, false); }
    );
  });
}

/* Clear the yellow "waiting" state and explain the 1.70 modal limitation. */
function emitConfirmTimeout(sink, what, ms) {
  var emit = typeof sink === 'function' ? sink
    : (sink && typeof sink.emit === 'function' ? sink.emit : null);
  if (!emit) { return; }
  var seconds = Math.round(ms / 1000);
  emit({
    type: 'awaitTimeout',
    text: '确认超时（' + seconds + ' 秒）：' + what + '已自动取消，Agent 继续。' +
      '屏幕上若仍有确认对话框，再点也不会执行该操作，可直接忽略或按 Esc 关闭。'
  });
}

/* Emit a "waiting for your confirmation" signal before any modal dialog.
 * The webview renders this text in yellow so it is obvious that the agent is
 * paused and a decision is required. Safe when no event sink is available. */
function emitAwaiting(sink, text) {
  var emit = typeof sink === 'function' ? sink
    : (sink && typeof sink.emit === 'function' ? sink.emit : null);
  if (emit) { emit({ type: 'awaiting', text: text }); }
}

/* runtime.getConfig() exposes the master write switch as constraints.allowWrite
 * (the legacy top-level allowWrite may be absent). Accept either shape so the
 * write tools actually work when write mode is enabled. */
function canWrite(config) {
  return Boolean(config && (
    config.allowWrite === true ||
    (config.constraints && config.constraints.allowWrite === true)
  ));
}

function isSubtaskMode(config) {
  return Boolean(config && (
    config.subtaskMode === true ||
    (config.constraints && config.constraints.subtaskMode === true)
  ));
}

/* Whether each write (insert/save/create) must be confirmed in a modal.
 * Mirrors confirmShell: when false, writes go straight through. Reads either
 * the top-level flag or constraints.confirmWrite for compatibility. */
function isWriteConfirm(config) {
  if (config && config.confirmWrite === false) { return false; }
  if (config && config.constraints && config.constraints.confirmWrite === false) { return false; }
  return true;
}

/* Ask for confirmation only when the switch is on. Emit the yellow awaiting
 * signal first; when the switch is off, skip both the signal and the modal.
 * A dialog nobody answers must not hang the run: it times out and is treated
 * as a rejection (with a distinct message so the model does not retry). */
async function confirmWriteAction(config, ctx, message, modalText, button) {
  if (!isWriteConfirm(config)) { return true; }
  const waitMs = confirmTimeoutMs(config);
  emitAwaiting(ctx && ctx.emit, message);
  const answer = await confirmWithTimeout(
    vscode.window.showWarningMessage(modalText, { modal: true }, button),
    waitMs,
    function () { emitConfirmTimeout(ctx && ctx.emit, '写入', waitMs); }
  );
  if (answer === CONFIRM_TIMEOUT) {
    throw new Error('CONFIRM TIMEOUT: nobody answered the write confirmation within ' +
      Math.round(waitMs / 1000) + ' s. This write was NOT performed. Do not retry automatically.');
  }
  return answer === button;
}

function historyLimit(config) {
  const n = Number(config && config.maxHistoryMessages);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : DEFAULT_MAX_HISTORY;
}

function contextCharLimit(config) {
  const n = Number(config && config.maxContextChars);
  return Number.isFinite(n) && n >= 2000 ? Math.floor(n) : DEFAULT_MAX_CONTEXT_CHARS;
}

/* Message count alone says nothing about size: three tool results can be
 * 12000 characters each. Walk backwards from the newest message and stop at
 * the character budget, so the model always sees the most recent turns and
 * never gets a half-empty context window of old chatter. */
function takeRecent(history, maxMessages, maxChars) {
  const picked = [];
  let used = 0;
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const m = list[i];
    const len = m && typeof m.content === 'string' ? m.content.length : 0;
    // The newest message is always kept, even when it alone exceeds the budget.
    if (picked.length && used + len > maxChars) { break; }
    picked.unshift(m);
    used += len;
  }
  return { messages: picked, chars: used, dropped: list.length - picked.length };
}

function subtaskLimit(config) {
  const n = Number(config && config.maxSubtasksPerRun);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_SUBTASKS;
}

/* ---- completion check -------------------------------------------------
 * The model's own "已完成" is not evidence. Every run keeps a small trace of
 * what actually happened (which tool ran, whether it succeeded, which file
 * was written and whether it really exists on disk) and hands it to
 * taskCheck.evaluate(), which renders a verifiable verdict under the answer. */

function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'user' && typeof m.content === 'string') { return m.content; }
  }
  return '';
}

/* Map a tool result string back to ok / failed / blocked. runTool() turns
 * exceptions into "TOOL ERROR: ..." and the gates into "TOOL BLOCKED: ...",
 * so the prefix is a reliable signal. Command failures carry a STATUS line. */
function toolStatusOf(result) {
  const text = String(result || '');
  if (text.indexOf('TOOL BLOCKED') === 0) { return 'blocked'; }
  if (text.indexOf('TOOL ERROR') === 0) { return 'failed'; }
  if (/^STATUS: (FAILED|TIMEOUT|STALLED|CANCELLED)/m.test(text)) { return 'failed'; }
  if (text.indexOf('子任务执行失败') !== -1) { return 'failed'; }
  return 'ok';
}

/* Verify a written file really exists, and whether this run touched it.
 * mtime has 1-2 s granularity on some Windows setups, hence the slack. */
function diskCheckOf(rel, startedAt) {
  try {
    const root = workspaceRoot();
    if (!root || !rel) { return null; }
    const full = path.resolve(root, rel);
    if (!fs.existsSync(full)) { return { path: rel, exists: false, size: 0, fresh: false }; }
    const st = fs.statSync(full);
    return {
      path: rel,
      exists: true,
      size: st.size,
      fresh: Number(st.mtimeMs) >= startedAt - 2000
    };
  } catch (e) {
    return { path: rel, exists: false, size: 0, fresh: false };
  }
}

function evaluateCheck(config, depth, userText, answer, trace) {
  if (depth > 0) { return null; }
  if (config && config.taskCheck === false) { return null; }
  try {
    return taskCheck.evaluate({ userText: userText, answer: answer, trace: trace });
  } catch (e) {
    return null;
  }
}

/* Verdicts that mean "the model only talked". They justify ONE automatic
 * nudge: with a small local model, telling it "you ran nothing, do it now" is
 * usually enough, and it spares the user from retyping the whole request. */
function needsAutoRetry(result) {
  return Boolean(result && (result.verdict === 'false-claim' || result.verdict === 'no-action'));
}

/* Emit the verdict. A broken check must never break the answer, so every
 * failure path here is swallowed. Subtask runs (depth > 0) stay quiet: the
 * parent already reports the overall result and would just get double cards. */
function emitCheck(emit, config, depth, userText, answer, trace) {
  if (typeof emit !== 'function') { return; }
  const result = evaluateCheck(config, depth, userText, answer, trace);
  if (!result || !result.level || result.level === 'none') { return; }
  emit({
    type: 'check',
    level: result.level,
    verdict: result.verdict,
    title: result.title,
    text: result.text,
    evidence: result.evidence || []
  });
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) { return null; }
  return folders[0].uri.fsPath;
}

/* A short file list straight in the system prompt. A small model cannot "look
 * around" the way a large one does: without this it spends whole rounds on
 * listFiles before it can even name a path. Capped so a huge repo cannot eat
 * the context window. */
async function workspaceDigest(limit) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) { return ''; }
  const max = Number(limit) > 0 ? Number(limit) : 80;
  let uris = [];
  try {
    uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.vscode}/**', max);
  } catch (e) {
    return '';
  }
  const lines = uris.map(function (uri) {
    try { return vscode.workspace.asRelativePath(uri).replace(/\\/g, '/'); } catch (e) { return ''; }
  }).filter(Boolean).sort();
  if (!lines.length) { return ''; }
  return lines.slice(0, max).join('\n') +
    (lines.length >= max ? '\n(只列出前 ' + max + ' 个；需要更多用 listFiles)' : '');
}

function safeRelPath(args, label) {
  const root = workspaceRoot();
  if (!root) { throw new Error('No workspace folder is open.'); }
  const rel = String(args.path || '');
  if (!rel) {
    throw new Error(label + ' requires args.path. Resend exactly as: {"tool":"' + label +
      '","args":{"path":"<workspace-relative path>"}}.');
  }
  if (!pathUtils.isPathInside(root, rel)) {
    throw new Error('Refusing to access a path outside the workspace folder: ' + rel);
  }
  if (!rules.isPathAllowed(rel, arguments[2] || ['**/*'])) {
    throw new Error('Path not allowed by win7Agent.constraints.allowedReadGlobs: ' + rel);
  }
  return { root: root, rel: rel, fullPath: path.resolve(root, rel) };
}

async function readFileTool(args, config) {
  const loc = safeRelPath(args, 'readFile', config.constraints.allowedReadGlobs);
  const uri = vscode.Uri.file(loc.fullPath);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File too large (' + stat.size + ' bytes > ' + MAX_FILE_BYTES + ').');
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  if (text.indexOf('\u0000') !== -1) { throw new Error('Binary file, not text.'); }
  return 'FILE: ' + loc.rel + '\n' + pathUtils.truncateMiddle(text, MAX_RESULT_CHARS);
}

async function importFileTool(args, config) {
  const loc = safeRelPath(args, 'importFile', config.constraints.allowedReadGlobs);
  const imported = fileImport.readAsText(loc.fullPath);
  return 'IMPORTED FILE: ' + loc.rel + ' (' + imported.kind + ', ' + imported.note +
    ', ' + imported.chars + ' chars' + (imported.truncated ? ', truncated' : '') + ')\n' +
    imported.text;
}

async function listFilesTool(args) {
  const pattern = String(args.pattern || '**/*');
  const uris = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,.vscode}/**', 200);
  if (!uris.length) { return '(no files matched ' + pattern + ')'; }
  return 'FILES (max 200):\n' + uris.map(function (u) {
    return vscode.workspace.asRelativePath(u);
  }).join('\n');
}

async function getActiveFileTool() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { throw new Error('No active editor.'); }
  const doc = editor.document;
  const selected = doc.getText(editor.selection);
  const text = selected || doc.getText();
  const name = vscode.workspace.asRelativePath(doc.uri);
  const scope = selected ? 'selection' : 'whole file';
  return 'FILE: ' + name + ' (' + scope + ', ' + doc.languageId + ')\n' + pathUtils.truncateMiddle(text, MAX_RESULT_CHARS);
}

async function insertTextTool(args, config, ctx) {
  if (!canWrite(config) || config.constraints.readOnly) {
    throw new Error('insertText is disabled (allowWrite=false or constraints.readOnly=true).');
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) { throw new Error('No active editor.'); }
  const text = String(args.text || '');
  if (!text) {
    throw new Error('insertText requires args.text. Resend exactly as: {"tool":"insertText","args":{"text":"<content to insert>"}}.');
  }
  if (text.length > MAX_WRITE_CHARS) {
    throw new Error('Text too long to insert: ' + text.length + ' chars, single-call limit is ' + MAX_WRITE_CHARS +
      '. Split the content into several shorter insertText calls.');
  }
  const relPath = vscode.workspace.asRelativePath
    ? vscode.workspace.asRelativePath(editor.document.uri || editor.document.fileName)
    : (editor.document.fileName || 'active-editor');
  const approved = await confirmWriteAction(config, ctx,
    '等待你确认（写入确认开关）：是否向 ' + editor.document.fileName + ' 插入 ' + text.length + ' 个字符？',
    'ZSZ.Win7.VSCode.AIAgent wants to insert ' + text.length + ' characters into ' + editor.document.fileName + '.',
    'Insert');
  if (!approved) { throw new Error('User rejected the write.'); }
  const ok = await editor.edit(function (builder) {
    builder.insert(editor.selection.end, text);
  });
  if (!ok) { throw new Error('Editor rejected the edit.'); }
  return 'Inserted ' + text.length + ' characters into the active editor.';
}

async function saveTextTool(args, config, ctx) {
  if (!canWrite(config) || config.constraints.readOnly) {
    throw new Error('saveText is disabled (allowWrite=false or constraints.readOnly=true).');
  }
  const loc = safeRelPath(args, 'saveText', config.constraints.allowedReadGlobs);
  const text = String(args.text || '');
  if (!text) {
    throw new Error('saveText requires args.text. Resend exactly as: {"tool":"saveText","args":{"path":"<workspace-relative path>","text":"<full new content>"}}.');
  }
  if (text.length > MAX_WRITE_CHARS) {
    throw new Error('Text too long to write: ' + text.length + ' chars, single-call limit is ' + MAX_WRITE_CHARS +
      '. Do NOT try to write it in one call again. Split the content into several smaller files (each within the limit) and create them one by one, or shorten the content.');
  }
  if (!fs.existsSync(path.dirname(loc.fullPath))) {
    // Checked BEFORE the confirmation dialog on purpose: no point asking the
    // user to approve a write that cannot happen. saveText only rewrites
    // existing files; createFile is the one that makes missing folders.
    throw new Error('Target directory does not exist: ' + path.dirname(loc.fullPath) +
      '. Use createFile to create this file (it creates missing parent folders), then saveText to update it.');
  }
  const approved = await confirmWriteAction(config, ctx,
    '等待你确认（写入确认开关）：是否写入文件 ' + loc.rel + '（' + text.length + ' 个字符）？',
    'ZSZ.Win7.VSCode.AIAgent wants to write ' + text.length + ' characters to ' + loc.rel + '.',
    'Write');
  if (!approved) { throw new Error('User rejected the write.'); }
  /* 快照在「已批准、未写入」之间采集：拒绝的写入不留无意义快照。 */
  if (ctx && Array.isArray(ctx.snapshots)) {
    const rec = snapLib.captureBefore(loc.fullPath, loc.rel);
    if (rec) { snapLib.record(ctx.snapshots, rec); }
  }
  fs.writeFileSync(loc.fullPath, text, 'utf8');
  return 'Wrote ' + text.length + ' characters to ' + loc.rel + '.';
}

/* Create a brand-new file, including any missing parent directories.
 * Unlike saveText this does NOT require the parent directory to pre-exist,
 * and it refuses to clobber an existing file unless overwrite=true is given
 * explicitly. Same write-mode gate and workspace boundary as the other tools. */
async function createFileTool(args, config, ctx) {
  if (!canWrite(config) || config.constraints.readOnly) {
    throw new Error('createFile is disabled (allowWrite=false or constraints.readOnly=true).');
  }
  const loc = safeRelPath(args, 'createFile', config.constraints.allowedReadGlobs);
  /* "dir/" names a folder, not a file. Windows happily writes a file literally
   * called "dir" if we pass it through, which is never what the model meant. */
  if (/[\\/]\s*$/.test(String(args.path || ''))) {
    throw new Error('createFile needs a file path, not a folder: "' + args.path +
      '". Drop the trailing slash and add a file name, e.g. "' + String(args.path).replace(/[\\/]+$/, '') + '/name.md".');
  }
  const text = String(args.text === undefined || args.text === null ? '' : args.text);
  if (text.length > MAX_WRITE_CHARS) {
    throw new Error('Text too long to write: ' + text.length + ' chars, single-call limit is ' + MAX_WRITE_CHARS +
      '. Do NOT try to write it in one call again. Split the content into several smaller files (each within the limit) and create them one by one, or shorten the content.');
  }
  const exists = fs.existsSync(loc.fullPath);
  const overwrite = args.overwrite === true;
  if (exists && !overwrite) {
    throw new Error('File already exists: ' + loc.rel + '. Use saveText to update it, or set args.overwrite=true to replace it.');
  }
  const approved = await confirmWriteAction(config, ctx,
    '等待你确认（写入确认开关）：是否' + (exists ? '覆盖' : '新建') + '文件 ' + loc.rel + '（' + text.length + ' 个字符）？',
    'ZSZ.Win7.VSCode.AIAgent wants to ' + (exists ? 'OVERWRITE' : 'CREATE') + ' file ' + loc.rel +
    ' with ' + text.length + ' characters (parent folders will be created if needed).',
    'Create');
  if (!approved) { throw new Error('User rejected file creation.'); }
  if (ctx && Array.isArray(ctx.snapshots)) {
    const rec = snapLib.captureBefore(loc.fullPath, loc.rel);
    if (rec) { snapLib.record(ctx.snapshots, rec); }
  }
  fs.mkdirSync(path.dirname(loc.fullPath), { recursive: true });
  fs.writeFileSync(loc.fullPath, text, 'utf8');
  return (exists ? 'Overwrote' : 'Created') + ' file ' + loc.rel + ' (' + text.length + ' characters).';
}

// 空白名单 = 放行任意命令；非空时按前缀（不区分大小写）匹配。
// 只填了空串（例如误配 [""]）按「什么都不放行」处理，绝不等于放行全部。
function isShellCommandAllowed(command, whitelist) {
  const raw = Array.isArray(whitelist) ? whitelist : [];
  if (!raw.length) { return true; }
  const list = raw.map(function (item) { return String(item === undefined || item === null ? '' : item).trim(); })
    .filter(function (item) { return item.length > 0; })
    .map(function (item) { return item.toLowerCase(); });
  if (!list.length) { return false; }
  const lowered = String(command || '').trim().toLowerCase();
  return list.some(function (prefix) {
    return lowered.indexOf(prefix) === 0;
  });
}

async function runCommandTool(args, config, ctx) {
  const c = config.constraints;
  if (!c.allowShell) {
    throw new Error('Shell execution is OFF (win7Agent.constraints.allowShell=false). Re-enable it, or remove runCommand from deniedTools if it is listed there.');
  }
  const command = String(args.command || '');
  if (!command.trim()) {
    throw new Error('runCommand requires args.command. Resend exactly as: {"tool":"runCommand","args":{"shell":"powershell","command":"<the full command>"}}.');
  }
  if (!isShellCommandAllowed(command, c.allowedShellCommands)) {
    throw new Error('Command is not in win7Agent.constraints.allowedShellCommands: ' + command.slice(0, 120));
  }
  /* Model asked for a shell it can't have (or none at all): resolve against
   * the user's preferShell setting and what actually exists on this machine.
   * resolved.note (if any) is echoed back so the model learns why. */
  const resolvedShell = shellEnv.resolveShell(config.preferShell, args.shell);
  const shell = resolvedShell.shell;
  if (c.confirmShell) {
    const waitMs = confirmTimeoutMs(config);
    emitAwaiting(ctx, '等待你确认（命令确认开关）：是否执行 ' + shellEnv.shellLabel(shell) + ' 命令？');
    const answer = await confirmWithTimeout(
      vscode.window.showWarningMessage(
        'ZSZ.Win7.VSCode.AIAgent wants to run a ' + shellEnv.shellLabel(shell) +
        ' command:\n\n' + command.slice(0, 500) + '\n\n' + proc.describeLimits(config.process),
        { modal: true },
        'Run'
      ),
      waitMs,
      function () { emitConfirmTimeout(ctx, '命令执行', waitMs); }
    );
    if (answer === CONFIRM_TIMEOUT) {
      throw new Error('CONFIRM TIMEOUT: nobody answered the command confirmation within ' +
        Math.round(waitMs / 1000) + ' s. The command was NOT executed. Do not retry automatically.');
    }
    if (answer !== 'Run') { throw new Error('User rejected the command.'); }
  }
  const result = await proc.runCommand({
    shell: shell,
    command: command,
    cwd: workspaceRoot() || undefined,
    bashPath: shellEnv.bashPath() || undefined,
    limits: config.process,
    token: ctx.token
  });
  const status = result.ok ? 'OK' : (result.stalled ? 'STALLED (killed)' : result.timedOut ? 'TIMEOUT (killed)' : result.cancelled ? 'CANCELLED' : 'FAILED');
  /* Wrong-dialect detector: bash syntax inside cmd, PowerShell cmdlets inside
   * cmd, && inside PS 5.1, %VAR% inside bash ... The hint is appended right
   * after the failure so the very next retry uses the right syntax. */
  let mismatch = '';
  if (!result.ok && !result.cancelled) {
    mismatch = shellEnv.diagnoseMismatch(shell, command,
      String(result.stderr || '') + '\n' + String(result.stdout || '') + '\n' + String(result.error || ''));
  }
  return 'COMMAND (' + shell + '): ' + command.slice(0, 200) +
    '\nSTATUS: ' + status + ' | exit=' + result.exitCode + ' | ' + result.durationMs + ' ms' +
    (resolvedShell.note ? '\nNOTE: ' + resolvedShell.note : '') +
    (result.truncated ? ' | output truncated' : '') +
    (result.error ? '\nERROR: ' + result.error : '') +
    (mismatch ? '\nHINT: 疑似 shell 语法错配——' + mismatch : '') +
    '\nSTDOUT:\n' + pathUtils.truncateMiddle(result.stdout || '(empty)', 4000) +
    '\nSTDERR:\n' + pathUtils.truncate(result.stderr || '(empty)', 1200);
}

/* Delegate one well-scoped piece of work to a sub-agent with its own context.
 * Same config, same cancellation token, same hard constraints. Depth and count
 * are bounded so a local model cannot recurse until the VS Code host dies. */
async function runSubtaskTool(args, config, ctx) {
  if (!isSubtaskMode(config)) {
    throw new Error('子任务模式未开启（win7Agent.subtaskMode=false），请在菜单中开启后再调用。');
  }
  const depth = Number(ctx.depth) || 0;
  if (depth >= SUBTASK_MAX_DEPTH) {
    throw new Error('子任务嵌套已达上限 ' + SUBTASK_MAX_DEPTH + ' 层，请直接完成当前工作。');
  }
  const state = ctx.taskState || { subtasks: 0 };
  const cap = subtaskLimit(config);
  if (state.subtasks >= cap) {
    throw new Error('本次任务的子任务数已达上限 ' + cap + '，请基于已有结果继续或汇总。');
  }
  const goal = String(args.goal || args.task || args.description || '').trim();
  if (!goal) { throw new Error('runSubtask 需要 args.goal（子任务目标）。'); }
  const context = pathUtils.truncate(String(args.context || args.background || ''), MAX_RESULT_CHARS);

  state.subtasks += 1;
  const index = state.subtasks;
  const label = '子任务 ' + index + (depth ? ' · 第' + (depth + 1) + '级' : '') + '：' + goal.slice(0, 70);
  const emit = typeof ctx.emit === 'function' ? ctx.emit : function () {};
  emit({ type: 'subtask', status: 'start', index: index, depth: depth + 1, text: label });

  const subConfig = Object.assign({}, config, {
    stream: false,
    maxToolRounds: Math.min(Number(config.maxToolRounds) || 20, 8)
  });
  const history = [{
    role: 'user',
    content: '你正在执行一个独立子任务，只交付这一项，不要重复主任务的其他部分。\n' +
      '目标：' + goal + '\n' +
      (context ? '背景与约束：' + context + '\n' : '') +
      '完成后给出简明结论；需要时用工具，工具返回后继续推进直到完成。'
  }];

  let result;
  try {
    result = await runAgent({
      config: subConfig,
      apiKey: ctx.apiKey || '',
      token: ctx.token,
      history: history,
      rules: ctx.rules || {},
      depth: depth + 1,
      taskState: state,
      // 子代理写的文件也要能撤回：共用父轮的快照列表。
      snapshots: Array.isArray(ctx.snapshots) ? ctx.snapshots : [],
      // A lesson learned inside a subtask is still a lesson: share the sink.
      onLesson: typeof ctx.onLesson === 'function' ? ctx.onLesson : null,
      autoLearn: typeof ctx.onLesson === 'function',
      onEvent: function (evt) {
        // Keep the parent transcript readable: forward meaningful steps only,
        // never the child's busy/progress/stream events.
        if (evt && ['phase', 'tool', 'awaiting', 'error', 'thought'].indexOf(evt.type) !== -1) {
          emit({ type: 'subtaskEvent', subtask: label, event: evt });
        }
      }
    });
  } catch (e) {
    result = '子任务执行失败：' + (e && e.message ? e.message : String(e));
  }
  emit({ type: 'subtask', status: 'done', index: index, depth: depth + 1,
    text: label + ' → ' + pathUtils.truncate(result || '(no result)', 80) });
  return 'SUBTASK RESULT [' + label + ']:\n' + result;
}

/* Collapse any error text to exactly one line: newlines, tabs and runs of
 * spaces all become a single space, then the tail is cut at MAX_ERROR_CHARS.
 * The prefix "TOOL ERROR: " is added by the caller and must stay intact. */
function oneLineError(text) {
  const flat = String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= MAX_ERROR_CHARS) { return flat; }
  return flat.slice(0, MAX_ERROR_CHARS) + '...';
}

/* Remove tool-template fragments (DSML markers, invoke/parameter tags) from a
 * reply so a degraded template never leaks as user-visible text. Only used
 * when hasBrokenToolTemplate() confirmed the reply is a broken call, so prose
 * that merely *discusses* such tags is untouched. */
function stripToolTemplateFragments(text) {
  let s = String(text || '');
  /* 整块抠掉「长得像工具调用」的 JSON（坏形/解析不出才走到这里，正常的调用
   * 已被执行不会进入本函数）。支持多行 JSON：按提取出的平衡块删除，而不是
   * 按行判断。普通讨论里没有 "tool": 键或工具名当键的 JSON，不会误伤。 */
  const blocks = extractJsonObjects(s);
  for (let i = 0; i < blocks.length; i++) {
    if (/"tool"\s*:/.test(blocks[i]) ||
        /\{\s*"(?:readFile|importFile|listFiles|getActiveFile|insertText|saveText|createFile|runCommand|runSubtask)"\s*:\s*\{/.test(blocks[i])) {
      /* 连同行尾换行一起删，避免独占一行的调用块留下空行 */
      s = s.replace(blocks[i] + '\n', '').replace(blocks[i], '');
    }
  }
  const lines = s.split('\n').filter(function (line) {
    if (/<\s*\/?\s*[｜|\s]*DSML/i.test(line)) { return false; }
    if (/<\s*\/?\s*(?:[｜|\s]{0,4}DSML[｜|\s]{0,4}\s*)?(?:invoke|parameter|tool_call|calls|function)\b/i.test(line)) { return false; }
    // DeepSeek 特殊 token 泄漏（全角 ｜ + 拉丁字母，如 <｜tool / <｜User｜>）
    if (/<[｜][A-Za-z]/.test(line)) { return false; }
    // 提取不出平衡块的残缺调用 JSON（截断形态）
    if (/"tool"\s*:\s*"[^"]+"\s*:\s*\{/.test(line)) { return false; }
    return true;
  });
  return lines.join('\n').trim();
}

async function runTool(call, config, ctx) {
  try {
    switch (call.tool) {
      case 'readFile': return await readFileTool(call.args, config);
      case 'importFile': return await importFileTool(call.args, config);
      case 'listFiles': return await listFilesTool(call.args);
      case 'getActiveFile': return await getActiveFileTool();
      case 'insertText': return await insertTextTool(call.args, config, ctx);
      case 'saveText': return await saveTextTool(call.args, config, ctx);
      case 'createFile': return await createFileTool(call.args, config, ctx);
      case 'runCommand': return await runCommandTool(call.args, config, ctx);
      case 'runSubtask': return await runSubtaskTool(call.args, config, ctx);
      default: return 'TOOL ERROR: unknown tool "' + oneLineError(call.tool) +
        '". Allowed: readFile, importFile, listFiles, getActiveFile, insertText, saveText, createFile, runCommand, runSubtask.';
    }
  } catch (e) {
    return 'TOOL ERROR: ' + oneLineError(e && e.message ? e.message : String(e));
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* Local pseudo-streaming. The request itself is always non-streaming, so the
 * tool loop keeps working; the finished text is then replayed in slices, which
 * looks the same to the user without costing any tool execution. The old
 * stream=true branch returned text only and silently skipped every tool. */
async function replayAsStream(text, emit, token) {
  const value = String(text || '');
  emit({ type: 'start' });
  for (let i = 0; i < value.length; i += STREAM_CHUNK_CHARS) {
    if (token && token.isCancellationRequested) { return; }
    emit({ type: 'delta', text: value.slice(i, i + STREAM_CHUNK_CHARS) });
    await sleep(STREAM_CHUNK_DELAY_MS);
  }
}

/* Qwen3 等混合思考模型会把思考过程内联在正文里（<think>...</think>），
 * 服务端模板没剥掉时整段原样显示，答案被顶到很后面，还容易让用户误以为
 * 模型在自言自语。这里把思考剥出来走「思考过程」折叠区，正文只留答案。
 * 工具调用解析仍用原始全文，防止调用写在思考块里被丢掉。 */
/* Small models write the tag in every shape: <THINK>, <think >, <thinking>,
 * sometimes unclosed. Normalize first so one code path handles them all;
 * otherwise the raw tag leaks into the visible answer. */
function splitInlineThinking(content) {
  const text = String(content || '');
  if (!/<\/?\s*think/i.test(text)) {
    return { visible: text, thinking: '' };
  }
  const normalized = text
    .replace(/<\s*think(?:ing)?\b[^>]*>/gi, '<think>')
    .replace(/<\s*\/\s*think(?:ing)?\s*>/gi, '</think>');
  let thinking = '';
  let visible = normalized.replace(/<think>([\s\S]*?)<\/think>/gi, function (m, inner) {
    const part = inner.trim();
    if (part) { thinking += (thinking ? '\n' : '') + part; }
    return '';
  });
  const openRe = /<think>/i;
  const m = visible.match(openRe);
  if (m) {
    const before = visible.slice(0, m.index);
    const rest = visible.slice(m.index + 7).trim();
    if (rest) { thinking += (thinking ? '\n' : '') + rest; }
    visible = before;
  }
  visible = visible.replace(/<\/think>/gi, '').replace(/^\s+/, '');
  return { visible: visible, thinking: thinking };
}

async function runAgent(params) {
  const config = params.config;
  const apiKey = params.apiKey;
  const token = params.token;
  const emit = typeof params.onEvent === 'function' ? params.onEvent : function () {};
  const history = params.history || [];
  const userRules = params.rules || {};
  const depth = Number(params.depth) || 0;
  const taskState = params.taskState || { subtasks: 0 };
  /* Auto-lessons: only persist AFTER a failure was actually recovered from
   * (a later call of the same tool succeeded), never on a lone error — an
   * error the run never solved is not a lesson, it is just bad luck. */
  const onLesson = typeof params.onLesson === 'function' ? params.onLesson : null;
  const autoLearn = params.autoLearn !== false && Boolean(onLesson);
  const pendingFixes = new Map();
  const startedAt = Date.now();
  let producedChars = 0;

  /* One trace per run: what the agent actually did, not what it says it did. */
  const trace = {
    rounds: 0,
    tools: [],
    writeChecks: [],
    error: '',
    cancelled: false,
    exhausted: false,
    streamMode: config.stream === true
  };
  const userText = lastUserText(history);
  /* Identical call -> how many times it has already failed in this run.
   * Small local models tend to repeat the exact same doomed call; every retry
   * is a wasted round and one more scary TOOL ERROR line in the chat. */
  const callFailures = new Map();

  let digest = '';
  if (depth === 0) { digest = await workspaceDigest(80); }
  const systemPrompt = rules.compileSystemPrompt({
    basePrompt: config.systemPrompt,
    defaultRules: config.defaultRules,
    memoryRules: userRules.memoryRules,
    lessons: userRules.lessons,
    rememberRules: config.rememberRules,
    constraints: config.constraints,
    subtaskMode: isSubtaskMode(config),
    workspaceDigest: digest,
    agentsMd: depth === 0 ? agentsMdLib.agentsMdSection(workspaceRoot()) : '',
    shellSection: shellEnv.shellSyntaxSection(config.preferShell)
  });
  // Two windows now: message count AND a character budget. The second one is
  // what actually protects a small model's context.
  const recent = takeRecent(history, historyLimit(config), contextCharLimit(config));
  const convo = [{ role: 'system', content: systemPrompt }].concat(recent.messages);
  const toolCtx = {
    token: token,
    emit: emit,
    depth: depth,
    taskState: taskState,
    apiKey: apiKey,
    rules: userRules,
    onLesson: autoLearn ? onLesson : null,
    /* 本轮写入快照：宿主传入共享数组（子任务也写进同一份），run 结束后
     * 宿主据此生成「撤回本轮改动」条目。 */
    snapshots: Array.isArray(params.snapshots) ? params.snapshots : []
  };

  function phase(text) {
    emit({ type: 'phase', text: text, elapsedMs: Date.now() - startedAt });
  }
  function progress(chars) {
    producedChars += chars;
    emit({ type: 'progress', chars: producedChars });
  }
  function onThought(piece) { emit({ type: 'thought', text: piece }); }

  emit({ type: 'busy', value: true, startedAt: startedAt, timeoutMs: config.timeoutMs });
  emit({ type: 'progress', chars: 0 });
  phase('正在连接模型服务 · 超时 ' + Math.round(config.timeoutMs / 1000) + ' s（可随时点 Stop）');

  let answer = '';
  let autoRetries = 0;
  let formatRetries = 0;
  try {
    for (let round = 0; round <= config.maxToolRounds; round++) {
      trace.rounds = round + 1;
      if (token && token.isCancellationRequested) {
        trace.cancelled = true;
        throw new Error('Cancelled.');
      }
      phase(round === 0 ? '请求已发送，等待模型响应（大模型首次加载可能数分钟）…'
        : '第 ' + round + ' 轮：工具结果已回填，继续推理…');

      let content = '';
      try {
        const result = await chatCompletion({
          config: config,
          apiKey: apiKey,
          messages: convo,
          stream: false,
          token: token,
          onThought: onThought,
          onRetry: function (text) { emit({ type: 'notice', text: text }); }
        });
        content = result.content;
      } catch (e) {
        throw new Error(classifyError(e, config));
      }
      // 内联思考块剥到「思考过程」折叠区；工具解析与历史仍用原始全文。
      const inline = splitInlineThinking(content);
      if (inline.thinking) { emit({ type: 'thought', text: inline.thinking }); }
      const visible = inline.visible;
      answer = visible;

      const calls = parseToolCalls(content);
      const call = calls[0] || null;
      if (!call) {
        /* Degraded tool-call template: the model clearly tried to call a tool
         * but the template carries no recoverable tool name (e.g. the invoke
         * open tag vanished, leaving only a parameter tag and a lone closing
         * tag). Feed a format error back instead of leaking the raw template
         * as chat text; after two attempts, show the prose with fragments
         * stripped. */
        const brokenTemplate = hasBrokenToolTemplate(content);
        if (brokenTemplate && formatRetries < BROKEN_TEMPLATE_RETRIES && round < config.maxToolRounds) {
          formatRetries += 1;
          phase('调用模板不完整，已要求模型重发');
          emit({ type: 'notice', text: '模型输出的调用模板不完整（无法识别工具名），已自动要求重发，原文不显示' });
          convo.push({ role: 'assistant', content: content });
          convo.push({
            role: 'user',
            content: 'TOOL FORMAT ERROR: 你上一条回复里的工具调用模板不完整（缺少工具名，或出现了泄漏的特殊标记），无法执行，模板原文已被丢弃。' +
              '请重新发送这次调用，只用最简单可靠的格式：一行 JSON，例如 {"tool":"runCommand","args":{"command":"...","shell":"powershell"}}。' +
              '如果这一步其实已经不需要执行（任务已完成），就不要输出任何调用模板，直接用文字回答。'
          });
          continue;
        }
        const shown = brokenTemplate
          ? (stripToolTemplateFragments(visible) || '（模型输出的调用模板不完整，已忽略。可重试或直接描述需求。）')
          : visible;
        answer = shown;
        /* 伪造执行记录的检测：本轮一次工具都没真跑，正文却出现工具输出的
         * 样子（TOOL RESULT / STATUS: OK …），基本是模型在自编执行过程。
         * 只提示，不改正文——用户据此判断「文件到底有没有被改动」。 */
        if (!trace.tools.length && /TOOL RESULT|STATUS:\s*(OK|FAILED|TIMEOUT|STALLED)/i.test(visible)) {
          emit({
            type: 'notice',
            text: '⚠ 回复里出现了「工具结果」样式的文字，但本轮没有任何真实工具执行——文件并未被改动，请勿据此认定操作已完成'
          });
        }
        /* The model answered with prose only. If this message asked for real
         * work and nothing ran, nudge it once instead of making the user type
         * the same request again. */
        const verdictInfo = evaluateCheck(config, depth, userText, visible, trace);
        if (autoRetries < AUTO_RETRY_MAX && needsAutoRetry(verdictInfo)) {
          autoRetries += 1;
          emit({ type: 'notice', text: '这一轮没有实际动作，已自动要求重做一次（仅一次）' });
          convo.push({ role: 'assistant', content: content });
          convo.push({
            role: 'user',
            content: '你没有调用任何工具，但这条消息要求实际动手（' +
              (verdictInfo && verdictInfo.title ? verdictInfo.title : '没有任何实际操作') +
              '）。请现在直接调用工具完成任务，不要只描述计划或说"已完成"。' +
              '如果确实不需要工具（纯问答），就直接回答并说明为什么不需要。'
          });
          continue;
        }
        if (config.stream === true) {
          await replayAsStream(shown, emit, token);
          progress(shown.length);
        } else {
          emit({ type: 'start' });
          emit({ type: 'delta', text: shown });
          progress(shown.length);
        }
        phase('完成');
        emitCheck(emit, config, depth, userText, visible, trace);
        return shown;
      }

      emit({ type: 'tool', text: 'tool -> ' + call.tool + ' ' + JSON.stringify(call.args).slice(0, 200), status: 'call', tool: call.tool });
      const verdict = rules.checkToolCall(call, config.constraints);
      const callKey = call.tool + '|' + JSON.stringify(call.args || {});
      const priorFails = callFailures.get(callKey) || 0;
      let result;

      if (priorFails >= 2) {
        // Third identical attempt: stop it here instead of producing another
        // identical error. The reason is spelled out so the model can adapt.
        phase('已跳过重复调用：' + call.tool);
        result = 'TOOL BLOCKED: this exact call (same tool, same arguments) already failed ' +
          priorFails + ' times in this run, so it was NOT executed again. ' +
          'Change something: use overwrite:true, use a workspace-relative path in the workspace, ' +
          'use createFile instead of saveText, or a different tool. Do not repeat it unchanged.';
      } else if (!verdict.allowed) {
        phase('已拦截：' + verdict.reason);
        result = 'TOOL BLOCKED BY CONSTRAINT: ' + verdict.reason +
          '\nDo NOT retry this tool. Answer using the information you already have.';
      } else if (config.constraints.requireToolApproval) {
        // This is a DIFFERENT gate from constraints.confirmShell. Say so, or
        // users who turned off "命令确认" think the switch is broken.
        const waitMs = confirmTimeoutMs(config);
        emitAwaiting(emit, '等待你确认：工具调用审批（独立于「命令确认」开关）— 是否允许调用 ' + call.tool + '？');
        const choice = await confirmWithTimeout(
          vscode.window.showWarningMessage(
            'ZSZ.Win7.VSCode.AIAgent wants to call tool ' + call.tool + ' with ' +
            JSON.stringify(call.args).slice(0, 300) +
            '\n\n（这是「工具审批」开关 win7Agent.constraints.requireToolApproval，' +
            '不是「命令确认」开关。关闭命令确认不会关闭这一步。）',
            { modal: true },
            'Allow'
          ),
          waitMs,
          function () { emitConfirmTimeout(emit, '工具审批', waitMs); }
        );
        if (choice === CONFIRM_TIMEOUT) {
          phase('工具审批超时（' + Math.round(waitMs / 1000) + ' 秒），本次工具调用未执行');
          result = 'TOOL BLOCKED: tool approval timed out after ' + Math.round(waitMs / 1000) +
            ' s; the tool was NOT called. Do not retry automatically.';
        } else if (choice !== 'Allow') {
          phase('用户拒绝了工具调用 ' + call.tool);
          result = 'TOOL BLOCKED: user rejected this tool call. Do not retry.';
        } else {
          phase('正在执行工具 ' + call.tool + '…');
          result = await runTool(call, config, toolCtx);
        }
      } else {
        phase('正在执行工具 ' + call.tool + '…');
        result = await runTool(call, config, toolCtx);
      }

      /* Several calls in one reply: only the first runs. Say so explicitly,
       * otherwise the model believes the rest were executed too. */
      if (calls.length > 1) {
        result += '\nNOTE: your reply contained ' + calls.length + ' tool calls; only the first (' +
          call.tool + ') was executed. Send one tool call per reply.';
      }

      const toolStatus = toolStatusOf(result);
      if (toolStatus === 'ok') { callFailures.delete(callKey); } else { callFailures.set(callKey, priorFails + 1); }

      /* 自动经验记忆：失败先记在案，同一个工具后来跑成功了才算「问题已解决」，
       * 这时才把解决方式沉淀成一条长期经验交给宿主持久化。只在报错当场总结
       * 会把「这次就是跑不通」的噪声也记成经验。 */
      if (toolStatus === 'failed' && !pendingFixes.has(call.tool)) {
        pendingFixes.set(call.tool, { tool: call.tool, error: result });
      }
      if (toolStatus === 'ok' && pendingFixes.has(call.tool)) {
        const failure = pendingFixes.get(call.tool);
        pendingFixes.delete(call.tool);
        const lesson = lessons.deriveLesson(failure);
        if (lesson && autoLearn) {
          try { await onLesson(lesson); } catch (e) { /* 记忆失败不影响任务本身 */ }
        }
      }
      trace.tools.push({
        tool: call.tool,
        status: toolStatus,
        path: String((call.args && call.args.path) || '')
      });
      if (toolStatus === 'ok' && (call.tool === 'saveText' || call.tool === 'createFile')) {
        const written = diskCheckOf(String((call.args && call.args.path) || ''), startedAt);
        if (written) { trace.writeChecks.push(written); }
      }

      emit({ type: 'tool', text: pathUtils.truncate(result, 600), status: toolStatus, tool: call.tool });
      convo.push({ role: 'assistant', content: content });
      convo.push({ role: 'user', content: 'TOOL RESULT for ' + call.tool + ':\n' + pathUtils.truncateMiddle(result, MAX_RESULT_CHARS) });
    }

    trace.exhausted = true;
    phase('达到工具轮数上限');
    emitCheck(emit, config, depth, userText, answer, trace);
    return answer || '(no answer)';
  } catch (e) {
    /* Errors and cancellations still get a verdict: the user needs to know
     * that this round did not finish, and what was already done before it broke. */
    trace.error = e && e.message ? e.message : String(e);
    if (token && token.isCancellationRequested) { trace.cancelled = true; }
    emitCheck(emit, config, depth, userText, answer, trace);
    throw e;
  } finally {
    emit({ type: 'busy', value: false, elapsedMs: Date.now() - startedAt });
  }
}

module.exports = {
  runAgent,
  parseToolCall,
  parseToolCalls,
  runTool,
  oneLineError,
  stripToolTemplateFragments,
  MAX_ERROR_CHARS,
  splitInlineThinking,
  isShellCommandAllowed,
  isSubtaskMode,
  isWriteConfirm,
  confirmWithTimeout,
  confirmTimeoutMs,
  CONFIRM_TIMEOUT,
  historyLimit,
  contextCharLimit,
  takeRecent,
  needsAutoRetry,
  MAX_RESULT_CHARS,
  DEFAULT_MAX_CONTEXT_CHARS,
  subtaskLimit,
  SUBTASK_MAX_DEPTH
};
