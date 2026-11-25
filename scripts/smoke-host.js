'use strict';

/*
 * End-to-end smoke test WITHOUT a real VS Code installation.
 * Injects a minimal `vscode` stub (claiming version 1.70.2), activates the
 * extension, resolves the webview, and drives full conversations against a
 * local mock OpenAI-compatible HTTP server. Also runs two real child processes
 * to prove command execution cannot hang.
 *
 * Run: node scripts/smoke-host.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const manifest = require('../package.json');

const settings = { 'http.proxy': '' };
const scoped = { global: {}, workspace: {}, workspaceFolder: {} };
const secrets = {};
const globalStore = {};
const events = [];
const commands = {};
let registeredProvider = null;
let viewMessageHandler = null;
let firstSystemPrompt = '';
let lastToolResult = '';
let lastMessages = [];
const createdPanels = [];
const executedCommands = [];

const defaults = manifest.contributes.configuration.properties;
let nextInputBoxValue = undefined;
let nextConfirmAnswer = undefined;
let neverResolveWarning = false;
let lastUpdateTarget = null;

function disposable() { return { dispose: function () {} }; }

const vscodeStub = {
  version: '1.70.2',
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: {
    file: function (p) { return { fsPath: p, toString: function () { return 'file://' + p; } }; },
    joinPath: function (base) {
      const parts = Array.prototype.slice.call(arguments, 1);
      const p = path.join.apply(path, [base.fsPath].concat(parts));
      return { fsPath: p, toString: function () { return 'file://' + p; } };
    }
  },
  window: {
    createOutputChannel: function () {
      return { appendLine: function () {}, show: function () {}, dispose: function () {} };
    },
    registerWebviewViewProvider: function (id, provider) {
      assert.strictEqual(id, 'win7Agent.chatView');
      registeredProvider = provider;
      return disposable();
    },
    showInputBox: async function (opts) {
      const v = nextInputBoxValue;
      nextInputBoxValue = undefined;
      if (opts && typeof opts.validateInput === 'function' && v !== undefined) {
        const err = opts.validateInput(v);
        if (err) { throw new Error('validateInput rejected: ' + err); }
      }
      return v;
    },
    showQuickPick: async function () { return undefined; },
    showOpenDialog: async function () { return undefined; },
    showSaveDialog: async function () { return undefined; },
    createWebviewPanel: function (viewType, title, column, options) {
      const panelWebview = {
        cspSource: 'vscode-resource:',
        html: '',
        options: null,
        asWebviewUri: function (uri) { return { toString: function () { return 'vscode-resource:' + uri.fsPath; } }; },
        postMessage: function () {},
        onDidReceiveMessage: function () { return disposable(); }
      };
      createdPanels.push({ viewType: viewType, title: title, column: column, options: options, webview: panelWebview });
      return {
        webview: panelWebview,
        reveal: function () {},
        onDidDispose: function () { return disposable(); },
        dispose: function () {}
      };
    },
    showInformationMessage: function () { return Promise.resolve(undefined); },
    showErrorMessage: function () { return Promise.resolve(undefined); },
    showWarningMessage: async function () {
      // Simulate a modal that is hidden behind another window / nobody clicks:
      // before the timeout fix this promise never settles and runAgent hangs.
      if (neverResolveWarning) { return new Promise(function () {}); }
      const a = nextConfirmAnswer;
      nextConfirmAnswer = undefined;
      return a;
    },
    activeTextEditor: {
      document: {
        languageId: 'javascript',
        uri: { fsPath: 'C:/proj/app.js' },
        getText: function () { return 'const answer = 42;'; }
      },
      selection: { isEmpty: true, end: { line: 0, character: 0 } },
      edit: async function () { return true; }
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:/proj' } }],
    getConfiguration: function (section) {
      const fullOf = function (key) { return section + '.' + key; };
      return {
        get: function (key) {
          if (section === 'http') { return settings['http.proxy']; }
          const full = fullOf(key);
          if (Object.prototype.hasOwnProperty.call(scoped.workspaceFolder, full)) { return scoped.workspaceFolder[full]; }
          if (Object.prototype.hasOwnProperty.call(scoped.workspace, full)) { return scoped.workspace[full]; }
          if (Object.prototype.hasOwnProperty.call(settings, full)) { return settings[full]; }
          const prop = defaults[full];
          return prop ? prop.default : undefined;
        },
        inspect: function (key) {
          const full = fullOf(key);
          return {
            key: full,
            defaultValue: defaults[full] ? defaults[full].default : undefined,
            globalValue: scoped.global[full],
            workspaceValue: scoped.workspace[full],
            workspaceFolderValue: scoped.workspaceFolder[full]
          };
        },
        update: async function (key, value, target) {
          const full = fullOf(key);
          let map = scoped.global;
          if (target === 2) { map = scoped.workspace; }
          if (target === 3) { map = scoped.workspaceFolder; }
          map[full] = value;
          settings[full] = value;
          lastUpdateTarget = target;
        }
      };
    },
    asRelativePath: function (uri) { return uri.fsPath || 'app.js'; },
    findFiles: async function () { return [{ fsPath: 'C:/proj/app.js' }]; },
    // Backed by the real disk when the path exists, so readFile's size gate and
    // binary detection can be tested for real; falls back to the fake project
    // file used by the conversation tests.
    fs: {
      stat: async function (uri) {
        try { return { size: fs.statSync(uri.fsPath).size }; } catch (e) { return { size: 42 }; }
      },
      readFile: async function (uri) {
        try { return fs.readFileSync(uri.fsPath); } catch (e) { return Buffer.from('const answer = 42;'); }
      }
    }
  },
  commands: {
    registerCommand: function (id, handler) { commands[id] = handler; return disposable(); },
    executeCommand: async function (id) {
      executedCommands.push(Array.prototype.slice.call(arguments));
      return undefined;
    }
  },
  extensions: {
    all: [
      { id: 'dugudexiao.win7-ai-agent', packageJSON: { version: '0.3.12' }, extensionPath: 'C:/ext/win7-ai-agent' },
      { id: 'some.publisher.ai-assistant', packageJSON: { displayName: 'AI Assistant', contributes: { configuration: { properties: {} }, commands: [] } }, extensionPath: 'C:/ext/other' }
    ]
  },
  ViewColumn: { Beside: -2, One: 1 },
  CancellationTokenSource: function () {
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: function () { return disposable(); }
    };
    this.cancel = function () { this.token.isCancellationRequested = true; };
    this.dispose = function () {};
  }
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') { return vscodeStub; }
  return originalLoad.apply(this, arguments);
};

function makeView() {
  const webview = {
    cspSource: 'vscode-resource:',
    html: '',
    options: null,
    asWebviewUri: function (uri) {
      return { toString: function () { return 'vscode-resource:' + uri.fsPath; } };
    },
    postMessage: function (msg) { events.push(msg); },
    onDidReceiveMessage: function (cb) { viewMessageHandler = cb; return disposable(); }
  };
  return { webview: webview, onDidDispose: function () { return disposable(); } };
}

let callCount = 0;
let lastAuth = 'unset';
let failNext = 0;
const scriptedResponses = [];
const server = http.createServer(function (req, res) {
  let body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () {
    callCount += 1;
    lastAuth = req.headers.authorization;
    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock overloaded' } }));
      return;
    }
    const parsed = body ? JSON.parse(body) : null;
    lastMessages = (parsed && parsed.messages) || [];
    let content;
    if (scriptedResponses.length) {
      content = scriptedResponses.shift();
    } else if (callCount === 1) {
      firstSystemPrompt = parsed.messages[0].content;
      content = '{"tool":"getActiveFile"}';
    } else if (callCount === 2) {
      const toolResult = parsed.messages[parsed.messages.length - 1].content;
      assert.ok(/TOOL RESULT for getActiveFile/.test(toolResult), 'tool result must be fed back');
      assert.ok(/const answer = 42/.test(toolResult), 'tool result must contain file content');
      content = 'Final answer from mock.';
    } else if (callCount === 3) {
      content = '{"tool":"insertText","args":{"text":"must not be written"}}';
    } else if (callCount === 4) {
      lastToolResult = parsed.messages[parsed.messages.length - 1].content;
      content = 'OK, that write was blocked.';
    } else {
      content = 'ok';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content } }] }));
  });
});

async function main() {
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  settings['win7Agent.model'] = 'qwen3.8-flash-next-unsloth-ud-iq4-xs';
  settings['win7Agent.stream'] = false;
  settings['win7Agent.maxToolRounds'] = 4;
  settings['win7Agent.timeoutMs'] = 1000000;

  const context = {
    subscriptions: [],
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    secrets: {
      get: async function (k) { return secrets[k] || ''; },
      store: async function (k, v) { secrets[k] = v; },
      delete: async function (k) { delete secrets[k]; }
    },
    globalState: {
      get: function (k, fallback) {
        return Object.prototype.hasOwnProperty.call(globalStore, k) ? globalStore[k] : fallback;
      },
      update: async function (k, v) { globalStore[k] = v; }
    }
  };

  const ext = require('../extension');
  await ext.activate(context);

  assert.strictEqual(Object.keys(commands).length, 21, 'all 21 commands must be registered');
  assert.ok(registeredProvider, 'webview provider must be registered');
  assert.ok(commands['win7Agent.toggleWriteMode'], 'write-mode toggle must be registered');
  assert.ok(commands['win7Agent.toggleShellConfirm'], 'shell-confirmation toggle must be registered');
  assert.ok(commands['win7Agent.toggleWriteConfirm'], 'write-confirmation toggle must be registered');
  assert.ok(commands['win7Agent.openChatPanel'], 'editor panel command must be registered');
  assert.ok(commands['win7Agent.toggleSubtaskMode'], 'subtask-mode toggle must be registered');
  ['win7Agent.showChanges', 'win7Agent.showChangeDiff', 'win7Agent.clearChanges', 'win7Agent.toggleChangeTracking'].forEach(function (id) {
    assert.ok(!commands[id], 'change-ledger command must be unregistered: ' + id);
  });
  assert.ok(commands['win7Agent.manageLessons'], 'auto-lesson manager command must be registered');
  assert.ok(commands['win7Agent.switchProfile'], 'model-profile switcher command must be registered (v1.11.4)');
  console.log('  PASS  activate() registered 21 commands and the webview provider');
  

  const runtime = require('../src/runtime');
  const config = runtime.getConfig();
  assert.strictEqual(config.model, 'qwen3.8-flash-next-unsloth-ud-iq4-xs');
  assert.strictEqual(config.localEndpoint, true);

  /* ---- v1.10.0: named model profiles, end to end against the stubbed host ---- */
  {
    const origBase = config.baseUrl;
    const origModel = config.model;
    const origKey = await runtime.getApiKey();
    const added = await runtime.addProfile('smoke-local', 'http://127.0.0.1:1234/v1', 'demo-model', 'sk-smoke');
    assert.ok(added.ok, 'addProfile must succeed: ' + (added.message || ''));
    assert.strictEqual(runtime.getProfiles().length, 1);
    assert.strictEqual(runtime.activeProfileName(), '', 'before applying, live settings do not match any profile');
    await runtime.applyProfile(runtime.getProfiles()[0]);
    const after = runtime.getConfig();
    assert.strictEqual(after.baseUrl, 'http://127.0.0.1:1234/v1', 'applyProfile must write baseUrl into settings');
    assert.strictEqual(after.model, 'demo-model', 'applyProfile must write model into settings');
    assert.strictEqual(runtime.activeProfileName(), 'smoke-local', 'after applying, the profile must be detected as active');
    const storedKey = await runtime.getApiKey();
    assert.strictEqual(storedKey, 'sk-smoke', 'applyProfile must push the profile key into SecretStorage');
    const del = await runtime.deleteProfile('smoke-local');
    assert.ok(del.ok && runtime.getProfiles().length === 0, 'deleteProfile must remove the profile');
    // restore the live endpoint so the rest of the smoke hits the mock server
    const cfgApi = require('vscode').workspace.getConfiguration('win7Agent');
    await cfgApi.update('baseUrl', origBase, 1);
    await cfgApi.update('model', origModel, 1);
    await runtime.setApiKey(origKey || '');
    assert.strictEqual(runtime.getConfig().model, origModel, 'the original endpoint must be restored');
    console.log('  PASS  model profiles: add / apply / detect-active / delete');
  }

  assert.strictEqual(Number(defaults['win7Agent.timeoutMs'].default), 1000000);
  assert.strictEqual(config.constraints.readOnly, true);
  assert.strictEqual(config.constraints.allowShell, true, 'shell must be ON by default');
  assert.strictEqual(config.constraints.confirmShell, true);
  assert.strictEqual(config.constraints.confirmWrite, true, 'write confirmation defaults ON');
  assert.strictEqual(config.subtaskMode, false, 'subtask mode defaults OFF');
  assert.strictEqual(config.constraints.deniedTools.indexOf('runCommand'), -1);
  assert.strictEqual(config.constraints.allowedShellCommands.length, 0, 'default shell whitelist must be empty = allow any command');
  const shellGate = require('../src/rules').checkToolCall(
    { tool: 'runCommand', args: { command: 'whoami' } }, config.constraints);
  assert.strictEqual(shellGate.allowed, true, 'runCommand must pass the hard constraints with new defaults');
  assert.strictEqual(config.constraints.confirmShell, true, 'per-command confirmation must remain ON');
  const isAllowed = require('../src/agent').isShellCommandAllowed;
  // Empty whitelist = AI may use any PowerShell / CMD command; confirmation is the real gate.
  ['Get-ChildItem', 'mkdir', 'copy', 'xcopy', 'robocopy', 'whoami',
   'python script.py', 'Remove-Item foo', 'rm -rf /', 'curl http://x'].forEach(function (cmd) {
    assert.strictEqual(isAllowed(cmd, config.constraints.allowedShellCommands), true,
      'empty whitelist must allow any command, got false for: ' + cmd);
  });
  // A non-empty whitelist still restricts, case-insensitively by prefix.
  assert.strictEqual(isAllowed('format C:', ['Get-ChildItem', 'dir']), false, 'non-empty whitelist must still restrict');
  assert.strictEqual(isAllowed('DIR C:\\', ['Dir']), true, 'non-empty whitelist prefix match must be case-insensitive');
  console.log('  PASS  defaults: local GGUF model, 1000 s timeout, read-only, shell ON with confirm, no command whitelist');
  console.log('  PASS  empty whitelist allows any PowerShell/CMD command; non-empty still restricts');

  const info = runtime.getExtensionInfo();
  assert.strictEqual(info.name, 'ZSZ.Win7.VSCode.AIAgent');
  assert.strictEqual(info.author, 'dugudexiao');
  assert.strictEqual(info.version, '1.11.5');
  await commands['win7Agent.about']();
  await commands['win7Agent.showPrompt']();
  await commands['win7Agent.manageRules']();
  await commands['win7Agent.importFile']();
  await commands['win7Agent.exportAnswer']();
  console.log('  PASS  new name, author and all rule/file commands run without a host');

  const added = await runtime.addMemoryRule('所有回答末尾加一句：已核对');
  assert.strictEqual(added.ok, true);
  assert.ok(runtime.getMemoryRules().indexOf('所有回答末尾加一句：已核对') !== -1);
  assert.ok(Array.isArray(globalStore['win7Agent.memoryRules']), 'rules must be persisted to globalState');
  assert.strictEqual(runtime.getRuleSummary().memoryCount, 1);
  console.log('  PASS  a standing rule is remembered and persisted in globalState');

  const view = makeView();
  registeredProvider.resolveWebviewView(view);
  assert.ok(/nonce-/.test(view.webview.html), 'CSP nonce must be present');
  assert.ok(/chat\.js/.test(view.webview.html) && /chat\.css/.test(view.webview.html), 'webview assets must be referenced');
  assert.ok(/markdown\.js/.test(view.webview.html), 'markdown renderer must be injected into the webview');
  assert.ok(/ZSZ\.Win7\.VSCode\.AIAgent/.test(view.webview.html), 'new app name must be in the webview');
  ['id="rules"', 'id="progress"', 'id="messages"', 'id="importbtn"', 'id="exportbtn"',
    'id="menuToggle"', 'id="menu"', 'id="flagWrite"', 'id="flagWriteConfirm"', 'id="flagShellConfirm"', 'id="flagSubtask"',
    'id="sessionBtn"', 'id="sessionMenu"', 'id="keybtn"', 'id="clear"',
    'id="queue"', 'id="panelbtn"', 'id="endpoint"', 'id="settings"'].forEach(function (id) {
    assert.ok(view.webview.html.indexOf(id) !== -1, 'webview must contain ' + id);
  });
  const rowHtml = (view.webview.html.match(/<div class="row">([\s\S]*?)<\/div>/) || [])[1] || '';
  assert.ok(rowHtml.indexOf('id="keybtn"') === -1, 'Set key must not sit among the composer buttons any more');
  assert.ok(rowHtml.indexOf('id="newchat"') === -1,
    'the separate new-chat button must be gone (new chat lives at the top of the session list)');
  assert.ok(rowHtml.indexOf('id="sessionBtn"') !== -1 && rowHtml.indexOf('id="sessionMenu"') !== -1,
    'session switcher + its list must sit in the composer row');
  assert.ok(rowHtml.indexOf('切换对话') !== -1,
    'the switcher label must be the fixed text 切换对话 (a long session title widened it and wrapped the row)');
  assert.ok(rowHtml.indexOf('<select') === -1, 'native select must be gone (it ignores the theme on Win7)');
  assert.ok(view.webview.html.indexOf('id="changesbtn"') === -1, 'change-ledger menu button must be removed');
  assert.ok(view.webview.html.indexOf('id="thoughts"') === -1,
    'the top thoughts drawer must be gone (thoughts render inline as segments since 1.9.0)');
  assert.ok(/src="[^"]*chat\.js\?v=1\.11\.5-\d+"/.test(view.webview.html),
    'script src must carry a build-stamp query so a same-folder upgrade cannot serve a cached old chat.js (v1.11.5)');
  assert.ok(/chat\.css\?v=1\.11\.5-\d+/.test(view.webview.html) && /markdown\.js\?v=1\.11\.5-\d+/.test(view.webview.html),
    'css and markdown loader must carry the build-stamp query too');
  assert.ok(/"repository"[^}]*github\.com\/dugudexiao-qq\/ZSZ\.Win7\.VSCode\.AIAgent/.test(require('fs').readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')),
    'package.json must point at the public repository (marketplace shows the link)');
  assert.ok(view.webview.html.indexOf('© ' ) !== -1 && view.webview.html.indexOf('MIT') !== -1,
    'the panel menu must carry the (c) author / MIT copyright line (v1.9.3)');
  /* ---- v1.10.0 UI wiring: profiles menu entry, snapshot row, compaction hook ---- */
  assert.ok(view.webview.html.indexOf('id="profiles"') !== -1,
    'the menu must expose the model-profile switcher button');
  {
    const chatJs = require('fs').readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
    assert.ok(chatJs.indexOf("case 'snapshot'") !== -1, 'chat.js must render the snapshot revert row');
    assert.ok(chatJs.indexOf('.snap-undo') !== -1 && chatJs.indexOf("type: 'revertSnapshot'") !== -1,
      'chat.js must delegate clicks on the snapshot undo button back to the host');
    assert.ok(chatJs.indexOf("type: 'profiles'") !== -1, 'chat.js must wire the profiles menu button');
    const cvSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
    assert.ok(cvSrc.indexOf('compactIfNeeded') !== -1, 'the host must attempt context compaction before each run');
    assert.ok(cvSrc.indexOf('_revertSnapshot') !== -1, 'the host must handle revertSnapshot messages');
    assert.ok(cvSrc.indexOf('snapshots: snap') !== -1, 'the host must share a snapshot array with runAgent');
    const agSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
    assert.ok(agSrc.indexOf('captureBefore') !== -1, 'write tools must capture a pre-write snapshot');
  }
  const segChatJs = require('fs').readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.ok(segChatJs.indexOf('addThoughtSeg') !== -1 && segChatJs.indexOf('addToolCallSeg') !== -1,
    'thoughts and tool calls must render as interleaved inline segments');
  assert.ok(/messagesEl\.addEventListener\('click'[\s\S]*seg-toggle/.test(segChatJs),
    'segment expand/collapse must use event delegation (survives innerHTML snapshot restore)');
  assert.ok(/class="menu" hidden/.test(view.webview.html), 'dropdown menu must start collapsed');
  assert.ok(!/class="subhdr"/.test(view.webview.html), 'old two-row sub-header must be gone');
  assert.ok(viewMessageHandler, 'message handler must be attached');
  console.log('  PASS  webview has CSP, assets, compact header + dropdown menu, and all controls');

  /* ---- 会话：新开、切回，history 各自独立 ---- */
  events.length = 0;
  const sessionOf = function (type) { return events.filter(function (m) { return m.type === type; }).pop(); };
  await viewMessageHandler({ type: 'newSession' });
  const listMsg = sessionOf('sessions');
  assert.ok(listMsg && listMsg.items.length >= 2, 'newSession must publish the session list');
  const freshId = listMsg.activeId;
  const olderId = listMsg.items.filter(function (s) { return s.id !== freshId; })[0].id;
  assert.notStrictEqual(registeredProvider._history, registeredProvider._findSession(olderId).history,
    'a new session must not share history with the previous one');
  await viewMessageHandler({ type: 'switchSession', id: olderId });
  const switched = sessionOf('sessions');
  assert.strictEqual(switched.activeId, olderId, 'switch must move the active session');
  assert.strictEqual(registeredProvider._history, registeredProvider._findSession(olderId).history,
    '_history must follow the active session');
  const replayMsg = sessionOf('replay');
  assert.ok(replayMsg && Array.isArray(replayMsg.items),
    'switching sessions must replay the persisted history into the webview (v1.11.4), or the panel looks empty');
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.ok(globalStore['win7Agent.sessions'], 'sessions must be persisted to globalState');

  /* 删除：删掉非当前会话只减一条；删掉当前会话要切到剩下的第一个 */
  const before = switched;
  events.length = 0;
  assert.ok(before.items.length >= 2, 'need at least two sessions to test deletion');
  const victim = before.items.filter(function (s) { return s.id !== before.activeId; })[0].id;
  await viewMessageHandler({ type: 'deleteSession', id: victim });
  const afterDel = sessionOf('sessions');
  assert.ok(afterDel && !afterDel.items.some(function (s) { return s.id === victim; }),
    'deleteSession must drop that conversation from the list');
  assert.strictEqual(afterDel.activeId, before.activeId, 'deleting an idle conversation must not switch the active one');

  events.length = 0;
  const activeNow = afterDel.activeId;
  await viewMessageHandler({ type: 'deleteSession', id: activeNow });
  const afterActiveDel = sessionOf('sessions');
  assert.ok(afterActiveDel, 'deleting the active conversation must republish the list');
  assert.ok(afterActiveDel.items.length >= 1, 'the list can never end up empty');
  assert.notStrictEqual(afterActiveDel.activeId, activeNow, 'active id must move to a surviving conversation');
  assert.strictEqual(registeredProvider._history,
    registeredProvider._findSession(afterActiveDel.activeId).history,
    'history must follow the surviving active conversation');
  const delReplay = sessionOf('replay');
  assert.ok(delReplay && Array.isArray(delReplay.items),
    'deleting the active conversation must replay the surviving history');
  console.log('  PASS  conversations: new session, switch back, delete (idle + active), histories stay separate');

  const fs = require('fs');
  const chatJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.ok(/conclusion-done/.test(chatJs) && /conclusion-flag/.test(chatJs), 'done handler must green-flag the final answer');
  assert.ok(/hadError/.test(chatJs), 'failed runs must not be green-flagged');
  assert.ok(/\.msg\.assistant\.conclusion-done/.test(chatCss) && /--vscode-testing-iconPassed/.test(chatCss), 'green conclusion styling must exist');
  const doneBlock = (chatCss.match(/\.msg\.assistant\.conclusion-done\s*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(/color:/.test(doneBlock), 'done state must set a green text color');
  assert.ok(!/background|border/.test(doneBlock), 'done state must be plain green text (no border / tinted background)');
  console.log('  PASS  successful answers get a green completion flag; failures stay red');

  const agentJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
  const rulesJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules.js'), 'utf8');
  assert.ok(/case 'createFile'/.test(agentJs) && /async function createFileTool/.test(agentJs), 'createFile tool must be implemented and dispatched');
  assert.ok(/mkdirSync/.test(agentJs) && /recursive: true/.test(agentJs), 'createFile must create missing parent directories');
  assert.ok(/createFile/.test(rulesJs) && /工具能力/.test(rulesJs), 'createFile must be gated by constraints and always advertised in the prompt');
  assert.ok(/createFile/.test(manifest.contributes.configuration.properties['win7Agent.systemPrompt'].default), 'default system prompt must mention createFile');
  console.log('  PASS  createFile tool is implemented, gated, and discoverable in the prompt');

  assert.ok(/emitAwaiting/.test(agentJs), 'agent must emit an awaiting signal before confirmation dialogs');
  assert.ok(/confirmWriteAction/.test(agentJs) && /isWriteConfirm/.test(agentJs),
    'write tools must go through the confirmWrite switch');
  assert.ok(/showWarningMessage/.test(agentJs) && /case 'awaiting'/.test(chatJs),
    'confirmation dialogs and their yellow awaiting signal must remain');
  assert.ok(/case 'awaiting'/.test(chatJs) && /ptext awaiting/.test(chatJs), 'webview must render awaiting text in yellow');
  assert.ok(/\.ptext\.awaiting/.test(chatCss) && /\.msg\.awaiting/.test(chatCss) && /editorWarning-foreground/.test(chatCss), 'yellow awaiting styling must exist');
  console.log('  PASS  pending confirmations are signalled and shown in yellow (green done / red error intact)');

  assert.ok(/function enqueue\(/.test(chatJs) && /function pumpQueue\(/.test(chatJs) &&
    /function renderQueue\(/.test(chatJs) && /queueRejected/.test(chatJs),
    'input must be queued while busy, with editable/reorderable entries');
  // v1.7.9：粘贴兜底与拖拽引用必须在 webview 和宿主两侧同时存在
  assert.ok(/addEventListener\('paste'/.test(chatJs) && /insertTextAtCaret/.test(chatJs) &&
    /addEventListener\('drop'/.test(chatJs) && /type: 'dropFiles'/.test(chatJs),
    'webview must take over paste and forward dropped files');
  assert.ok(/_resolveDrops/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8')),
    'host must resolve dropped files into workspace-relative @tokens');
  assert.ok(/subtaskMode/.test(chatJs) && /case 'subtask'/.test(chatJs), 'subtask progress must be visible in chat');
  assert.ok(/\.queue\s*\{/.test(chatCss) && /\.qitem\s*\{/.test(chatCss) && /\.msg\.subtask\s*\{/.test(chatCss),
    'queue and subtask UI styling must exist');
  assert.ok(/settingTarget/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime.js'), 'utf8')),
    'toggles must write to the scope that actually wins');
  console.log('  PASS  editable input queue + subtask mode UI are wired');

  /* v1.8.0：导入的文件要出现在输入框上方（附件条），并且能被撤回；
   * 自动经验要有入口可管理。宿主与 webview 两侧都查，只有一侧存在等于没做。 */
  const chatViewSrcForAttach = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
  assert.ok(/id="attachments"/.test(chatViewSrcForAttach) && /id="lessons"/.test(chatViewSrcForAttach),
    'composer must carry an attachment bar and a lessons menu entry');
  assert.ok(/function renderAttachments\(/.test(chatJs) && /case 'attachment'/.test(chatJs) &&
    /removeAttachment/.test(chatJs), 'webview must render and revoke imported files');
  assert.ok(/_removeAttachment/.test(chatViewSrcForAttach) && /attachmentRemoved/.test(chatViewSrcForAttach),
    'host must drop the imported content when the chip is removed');
  assert.ok(/\.attach-bar\s*\{/.test(chatCss) && /\.achip\s*\{/.test(chatCss) && /\.msg\.lesson\s*\{/.test(chatCss),
    'attachment bar and lesson notice must be styled');
  assert.ok(/manageLessons/.test(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8')),
    'lessons must be inspectable/deletable from a command');
  console.log('  PASS  imported files sit above the input box and auto-lessons have a manager');

  assert.ok(!/case 'change'/.test(chatJs) && !/function addChange\(/.test(chatJs) &&
    !/change-diffbtn/.test(chatCss), 'change-ledger chat UI must be removed');
  const chatViewSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
  assert.ok(!/case 'viewDiff'/.test(chatViewSrc) && !/showChangeDiff/.test(chatViewSrc) &&
    !/changeCount/.test(chatViewSrc), 'webview must no longer route viewDiff or expose the change count');
  console.log('  PASS  built-in change ledger UI is fully removed (v1.7.1)');

  assert.ok(/setMenu\(menuEl\.hidden\)/.test(chatJs), 'kebab button must toggle the dropdown');
  assert.ok(/Escape/.test(chatJs) && /setMenu\(false\)/.test(chatJs), 'Escape/outside click must close the dropdown');
  assert.ok(/\.menu\[hidden\]/.test(chatCss) && /\.menu-item/.test(chatCss), 'dropdown styling must exist');
  console.log('  PASS  compact dropdown opens on kebab, closes on outside click / Escape');

  await runtime.setApiKey('sk-smoke-test');
  await registeredProvider.postState();
  const state = events.filter(function (e) { return e.type === 'state'; }).pop();
  assert.strictEqual(state.hasKey, true);
  assert.strictEqual(state.author, 'dugudexiao');
  assert.strictEqual(state.version, '1.11.5');
  assert.strictEqual(state.appName, 'ZSZ.Win7.VSCode.AIAgent');
  assert.strictEqual(state.timeoutSec, 1000);
  assert.ok(state.ruleCount >= 3, '2 default rules + 1 remembered rule');
  console.log('  PASS  webview state exposes author, app name, 1000 s timeout and rule count');

  events.length = 0;
  await viewMessageHandler({ type: 'send', text: 'what is in the active file?' });

  assert.strictEqual(callCount, 2, 'one tool round + one final answer');
  assert.ok(/回答一律使用简体中文/.test(firstSystemPrompt), 'shipped default rules must reach the system prompt');
  assert.ok(/所有回答末尾加一句：已核对/.test(firstSystemPrompt), 'remembered rule must reach the system prompt');
  assert.ok(/运行约束/.test(firstSystemPrompt) && /优先级/.test(firstSystemPrompt), 'constraints + priority must be injected');
  assert.ok(/## 工作区文件/.test(firstSystemPrompt), 'the workspace file list must be injected up front');
  assert.ok(/app\.js/.test(firstSystemPrompt), 'the injected list must contain real relative paths');
  // The compiled prompt actually sent to the model must not scare it out of
  // whole-directory copy tasks by implying runCommand is workspace-bound.
  assert.ok(/工作方式/.test(firstSystemPrompt), 'work-style guidance must reach the real model prompt');
  assert.ok(/runCommand 执行本机命令，不受此工作区路径限制/.test(firstSystemPrompt),
    'real prompt must state runCommand is not workspace-path-bound');
  assert.ok(/Copy-Item|robocopy/.test(firstSystemPrompt), 'real prompt must teach one-command directory copy');
  assert.ok(!/工作区外路径、绝对路径越界、二进制文件、超过 200 KB 的文件一律拒绝/.test(firstSystemPrompt),
    'the old blanket "all out-of-workspace paths rejected" wording must be gone');
  const phases = events.filter(function (e) { return e.type === 'phase'; });
  assert.ok(phases.length >= 2, 'the UI must receive visible phase updates');
  assert.ok(events.some(function (e) { return e.type === 'busy' && e.value === true; }), 'busy start must be emitted');
  assert.ok(events.some(function (e) { return e.type === 'busy' && e.value === false; }), 'busy end must be emitted');
  assert.ok(events.some(function (e) { return e.type === 'progress'; }), 'progress events must be emitted');
  const deltas = events.filter(function (e) { return e.type === 'delta'; });
  assert.ok(deltas.length && /Final answer from mock/.test(deltas[deltas.length - 1].text), 'final answer must reach the webview');
  // done 是「这一轮结束」的信号，后面只允许状态刷新（state / sessions），
  // 不能再有内容事件，否则前端会把下一轮的输出画到上一轮里。
  const lastDone = events.map(function (e) { return e.type; }).lastIndexOf('done');
  assert.ok(lastDone !== -1, 'round must end with done');
  assert.ok(events.slice(lastDone + 1).every(function (e) { return e.type === 'state' || e.type === 'sessions'; }),
    'only state refreshes may follow done');
  console.log('  PASS  full agent loop + rules in prompt + phase/busy/progress feedback');

  events.length = 0;
  await viewMessageHandler({ type: 'send', text: 'now write something' });
  assert.ok(/TOOL BLOCKED BY CONSTRAINT/.test(lastToolResult), 'read-only constraint must block insertText');
  assert.ok(events.some(function (e) {
    return e.type === 'tool' && /BLOCKED/.test(e.text);
  }), 'the UI must show that the tool was blocked');
  assert.ok(!events.some(function (e) { return e.type === 'error'; }), 'a blocked tool is not a fatal error');
  console.log('  PASS  hard constraint blocks a write before the tool function runs');

  await runtime.clearApiKey();
  events.length = 0;
  lastAuth = undefined;
  await viewMessageHandler({ type: 'send', text: 'ping without a key' });
  assert.ok(!events.some(function (e) { return e.type === 'error'; }), 'local endpoints must work without a key');
  assert.ok(events.some(function (e) { return e.type === 'done'; }), 'local round must finish with done');
  assert.strictEqual(lastAuth, undefined, 'no Authorization header when the key is empty');
  console.log('  PASS  local endpoint works with no key and sends no Authorization header');

  const { checkConnection } = require('../src/llmClient');
  const diag = await checkConnection({ config: runtime.getConfig(), apiKey: 'sk-smoke-test', timeoutMs: 5000 });
  assert.strictEqual(diag.ok, true, 'diagnose should succeed: ' + diag.detail);
  console.log('  PASS  diagnose command path returns OK');

  /* Mixed text + JSON tool call must actually execute, not be mistaken for a final
   * answer (which used to mark the task "done" while doing nothing). */
  const beforeMixed = callCount;
  scriptedResponses.push('工作区只有 3 个文件，先读第一个：\n{"tool":"getActiveFile","args":{}}');
  scriptedResponses.push('文件读完了，这是最终回答。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '读当前文件，混合格式' });
  assert.strictEqual(callCount, beforeMixed + 2, 'mixed text+JSON must trigger a tool round + a final answer');
  assert.ok(events.some(function (e) {
    return e.type === 'tool' && /tool -> getActiveFile/.test(e.text);
  }), 'the tool call embedded in prose must be detected and executed');
  assert.ok(events.some(function (e) {
    return e.type === 'tool' && /const answer = 42/.test(e.text);
  }), 'the executed tool result (file content) must reach the webview');
  const mixedDeltas = events.filter(function (e) { return e.type === 'delta'; });
  assert.ok(mixedDeltas.some(function (e) { return /文件读完了/.test(e.text); }), 'final prose answer must reach the webview');
  console.log('  PASS  mixed prose + JSON tool calls execute for real (no false "done")');

  /* Long conversations must not be cut off after 10 rounds / 20 messages. */
  settings['win7Agent.maxHistoryMessages'] = 200;
  settings['win7Agent.maxToolRounds'] = 20;
  scriptedResponses.length = 0;
  for (let i = 0; i < 12; i++) { scriptedResponses.push('{"tool":"listFiles","args":{}}'); }
  scriptedResponses.push('第十二轮之后的最终回答');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: 'ROUND_TEST_MARKER' });
  assert.ok(lastMessages.some(function (m) { return /ROUND_TEST_MARKER/.test(m.content || ''); }),
    'first user message must survive 12 tool rounds when maxHistoryMessages is raised');
  assert.ok(events.some(function (e) { return e.type === 'delta' && /第十二轮之后/.test(e.text || ''); }),
    'the 13th model response must be delivered as the final answer');
  console.log('  PASS  12+ tool rounds keep the early context and finish normally');
  settings['win7Agent.maxToolRounds'] = 4;

  /* Sub-task mode: parent delegates, child runs in its own context, parent
   * must read the returned result before it can finish. v1.2.0: OFF by
   * default, so the test toggles it on explicitly. */
  assert.strictEqual(runtime.isSubtaskMode(), false, 'subtask mode must be OFF by default');
  await runtime.setSubtaskMode(true);
  assert.strictEqual(runtime.isSubtaskMode(), true);
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"runSubtask","args":{"goal":"核对工作区文件清单","context":"只读"}}');
  scriptedResponses.push('子任务结论：共 1 个文件。');
  scriptedResponses.push('已汇总子任务结论，任务完成。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '请把核对工作拆成子任务' });
  assert.ok(events.some(function (e) { return e.type === 'subtask' && e.status === 'start'; }), 'subtask start must be visible');
  assert.ok(events.some(function (e) { return e.type === 'subtask' && e.status === 'done'; }), 'subtask completion must be visible');
  assert.ok(events.some(function (e) {
    return e.type === 'tool' && /SUBTASK RESULT/.test(e.text || '') && /共 1 个文件/.test(e.text || '');
  }), 'parent must receive the child result as a tool result');
  assert.ok(events.some(function (e) { return e.type === 'delta' && /已汇总子任务结论/.test(e.text || ''); }),
    'parent must finish only after the subtask result');
  console.log('  PASS  runSubtask executes an isolated child agent and feeds its conclusion back');

  /* Sub-task depth is bounded: a child cannot recursively spawn forever. */
  const subCfg = runtime.getConfig();
  const nested = await require('../src/agent').runTool(
    { tool: 'runSubtask', args: { goal: 'nested' } },
    subCfg,
    { token: { isCancellationRequested: false }, emit: function () {}, depth: 2 }
  );
  assert.ok(/嵌套已达上限/.test(nested), 'subtask recursion must be blocked at depth 2: ' + nested);
  await runtime.setSubtaskMode(false); // restore default-OFF for later checks
  assert.strictEqual(runtime.isSubtaskMode(), false);
  console.log('  PASS  nested subtasks stop at the depth limit');

  /* Real child processes: argv-array construction must not hang. */
  const { runCommand } = require('../src/processRunner');
  const echo = await runCommand({
    shell: 'cmd', command: 'echo hello_win7',
    limits: { timeoutMs: 8000, idleTimeoutMs: 5000, maxOutputBytes: 4096 }
  });
  assert.strictEqual(echo.ok, true, 'cmd echo should succeed: ' + echo.error);
  assert.ok(/hello_win7/.test(echo.stdout));
  assert.ok(echo.durationMs < 8000);
  console.log('  PASS  real CMD execution returns promptly (stdin ignored, no hang)');

  const ps = await runCommand({
    shell: 'powershell', command: 'Write-Output "a & b $env:USERNAME 中文"',
    limits: { timeoutMs: 10000, idleTimeoutMs: 6000, maxOutputBytes: 8192 }
  });
  if (/ENOENT/.test(ps.error || '')) {
    console.log('  SKIP  PowerShell not available on this host');
  } else {
    assert.strictEqual(ps.ok, true, 'PowerShell with special characters should succeed: ' + ps.error);
    assert.ok(/中文/.test(ps.stdout), 'UTF-8 console prelude must prevent mojibake');
    console.log('  PASS  PowerShell EncodedCommand survives & $ quotes and Chinese text');
  }

  const stuck = await runCommand({
    shell: 'cmd', command: 'ping -n 10 127.0.0.1 >nul',
    limits: { timeoutMs: 1200, idleTimeoutMs: 700, maxOutputBytes: 4096 }
  });
  assert.strictEqual(stuck.ok, false, 'a silent long-running command must be terminated');
  assert.ok(stuck.timedOut || stuck.stalled, 'the no-response mechanism must trigger');
  assert.ok(stuck.durationMs < 6000, 'it must be killed quickly, not left running');
  console.log('  PASS  no-output / wall-clock timeout kills a stuck process tree');

  /* Endpoint command must work without the Settings UI at all. */
  nextInputBoxValue = '192.168.5.9:9000';
  await commands['win7Agent.setEndpoint']();
  assert.strictEqual(settings['win7Agent.baseUrl'], 'http://192.168.5.9:9000/v1', 'setEndpoint must persist the URL');
  assert.strictEqual(lastUpdateTarget, 1, 'must write to Global (user) settings');
  assert.strictEqual(runtime.getConfig().baseUrl, 'http://192.168.5.9:9000/v1', 'runtime must pick up the new value');
  nextInputBoxValue = '9100';
  await commands['win7Agent.setEndpoint']();
  assert.strictEqual(settings['win7Agent.baseUrl'], 'http://192.168.5.9:9100/v1', 'port-only input must keep the host');
  await commands['win7Agent.openSettingsJson']();
  console.log('  PASS  Set Server URL / Port writes user settings without the Settings UI');

  /* Write mode: one command flips all three gates, and back. */
  assert.strictEqual(runtime.isWriteMode(), false, 'default must be read-only');
  await runtime.setWriteMode(true);
  assert.strictEqual(runtime.isWriteMode(), true, 'write mode must flip all three gates on');
  assert.strictEqual(settings['win7Agent.constraints.readOnly'], false);
  assert.strictEqual(settings['win7Agent.allowWrite'], true);
  assert.ok(settings['win7Agent.constraints.deniedTools'].indexOf('insertText') === -1);
  await runtime.setWriteMode(false);
  assert.strictEqual(runtime.isWriteMode(), false, 'write mode must be reversible');
  assert.strictEqual(settings['win7Agent.constraints.readOnly'], true);
  assert.ok(settings['win7Agent.constraints.deniedTools'].indexOf('insertText') !== -1);
  console.log('  PASS  write-mode toggle flips readOnly/allowWrite/deniedTools and back');

  /* Shell confirmation: independent user-facing switch, persists and is reversible. */
  assert.strictEqual(runtime.isShellConfirm(), true, 'shell confirmation must be ON by default');
  await runtime.setShellConfirm(false);
  assert.strictEqual(runtime.isShellConfirm(), false, 'shell confirmation must be switchable OFF');
  assert.strictEqual(settings['win7Agent.constraints.confirmShell'], false, 'confirmShell must persist to user settings');
  assert.strictEqual(runtime.getConfig().constraints.confirmShell, false, 'runtime config must pick up confirmShell=false');
  await runtime.setShellConfirm(true);
  assert.strictEqual(runtime.isShellConfirm(), true, 'shell confirmation must be reversible');

  // A workspace setting outranks the user setting. Writing Global only would
  // show "off" in the menu while runCommand kept popping a dialog.
  scoped.workspace['win7Agent.constraints.confirmShell'] = true;
  settings['win7Agent.constraints.confirmShell'] = true;
  assert.strictEqual(runtime.isShellConfirm(), true, 'workspace setting must win when present');
  await runtime.setShellConfirm(false);
  assert.strictEqual(lastUpdateTarget, 2, 'toggle must write the effective Workspace scope');
  assert.strictEqual(runtime.isShellConfirm(), false, 'toggle must actually disable confirmation');
  assert.strictEqual(scoped.workspace['win7Agent.constraints.confirmShell'], false);
  delete scoped.workspace['win7Agent.constraints.confirmShell'];
  await runtime.setShellConfirm(true);
  console.log('  PASS  shell confirmation toggles the effective scope, even under a workspace override');

  assert.strictEqual(runtime.isSubtaskMode(), false, 'subtask mode must be OFF by default (v1.2.0)');
  await runtime.setSubtaskMode(true);
  assert.strictEqual(runtime.isSubtaskMode(), true, 'subtask mode must be switchable on');
  await runtime.setSubtaskMode(false);
  assert.strictEqual(runtime.isSubtaskMode(), false, 'subtask mode must be reversible');
  console.log('  PASS  subtask-mode switch toggles and persists reversibly (default OFF)');

  /* The reported bug: with confirmShell=false a .bat / cmd command must run
   * straight away, with no modal at all. */
  const beforeGate = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];
  await runtime.setShellConfirm(false);
  nextConfirmAnswer = undefined; // any modal would resolve to "rejected"
  const runCfg = runtime.getConfig();
  const noConfirm = await require('../src/agent').runTool(
    { tool: 'runCommand', args: { shell: 'cmd', command: 'echo ZSZ_NO_CONFIRM' } },
    runCfg,
    { token: { isCancellationRequested: false }, emit: function () {} }
  );
  assert.ok(/STATUS: OK/.test(noConfirm), 'command must run with confirmation off: ' + noConfirm);
  assert.ok(/ZSZ_NO_CONFIRM/.test(noConfirm), 'command output must be reported');
  await runtime.setShellConfirm(true);
  vscodeStub.workspace.workspaceFolders = beforeGate;
  console.log('  PASS  CMD/.bat commands run without any dialog when confirmation is off');

  /* createFile: a real file is written into a temp workspace, including missing
   * parent folders; existing files are protected unless overwrite=true. */
  const os = require('os');
  const fsmod = require('fs');
  const tmpRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-createfile-'));
  const savedFolders = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
  await runtime.setWriteMode(true);
  const { runTool } = require('../src/agent');
  const writeEvents = [];
  const writeCtx = { token: { isCancellationRequested: false }, emit: function (e) { writeEvents.push(e); } };
  const liveCfg = runtime.getConfig();
  nextConfirmAnswer = 'Create';
  const made = await runTool({ tool: 'createFile', args: { path: 'nested/deep/new.txt', text: 'hello zsz' } }, liveCfg, writeCtx);
  assert.ok(/^Created file/.test(made), 'createFile must report a new file: ' + made);
  const madePath = path.join(tmpRoot, 'nested', 'deep', 'new.txt');
  assert.strictEqual(fsmod.readFileSync(madePath, 'utf8'), 'hello zsz', 'nested dirs + file content must be written');
  assert.strictEqual(writeEvents.filter(function (e) { return e && e.type === 'change'; }).length, 0,
    'no change-ledger events may be emitted (feature removed in v1.7.1)');
  const dup = await runTool({ tool: 'createFile', args: { path: 'nested/deep/new.txt', text: 'x' } }, liveCfg, writeCtx);
  assert.ok(/already exists/.test(dup), 'createFile must refuse to clobber an existing file: ' + dup);
  nextConfirmAnswer = 'Create';
  const over = await runTool({ tool: 'createFile', args: { path: 'nested/deep/new.txt', text: 'replaced', overwrite: true } }, liveCfg, writeCtx);
  assert.ok(/^Overwrote file/.test(over), 'overwrite=true must allow replacing: ' + over);
  assert.strictEqual(fsmod.readFileSync(madePath, 'utf8'), 'replaced');
  nextConfirmAnswer = undefined;
  vscodeStub.workspace.workspaceFolders = savedFolders;
  await runtime.setWriteMode(false);
  fsmod.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('  PASS  createFile writes new files with parent dirs, blocks overwrite unless asked');

  /* THE REPORTED BUG: with confirmWrite=false, writing a .py file must NOT pop
   * any dialog. 1.0.0/1.1.0 hard-coded the modal and had no switch at all. */
  const tmpRoot2 = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-write-noconfirm-'));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot2 } }];
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  const noConfirmCfg = runtime.getConfig();
  assert.strictEqual(noConfirmCfg.constraints.confirmWrite, false);
  assert.strictEqual(require('../src/agent').isWriteConfirm(noConfirmCfg), false);
  let awaitingDuringWrite = 0;
  const noConfirmCtx = { token: { isCancellationRequested: false }, emit: function (e) {
    if (e && e.type === 'awaiting') { awaitingDuringWrite++; }
  } };
  // If any modal appeared it would resolve to "rejected" (no answer set) and
  // the write would fail — so success here proves there was no dialog.
  nextConfirmAnswer = undefined;
  const pyMade = await runTool({ tool: 'createFile', args: { path: 'nested/write_no_confirm.py', text: 'print(1)\n' } }, noConfirmCfg, noConfirmCtx);
  assert.ok(/^Created file/.test(pyMade), 'write with confirmWrite=false must succeed without a dialog: ' + pyMade);
  assert.strictEqual(fsmod.readFileSync(path.join(tmpRoot2, 'nested', 'write_no_confirm.py'), 'utf8'), 'print(1)\n');
  assert.strictEqual(awaitingDuringWrite, 0, 'no yellow awaiting signal when write confirmation is off');
  const pySaved = await runTool({ tool: 'saveText', args: { path: 'nested/write_no_confirm.py', text: 'print(2)\n' } }, noConfirmCfg, noConfirmCtx);
  assert.ok(/^Wrote /.test(pySaved), 'saveText must also skip the modal: ' + pySaved);
  assert.strictEqual(awaitingDuringWrite, 0, 'saveText must not signal awaiting either');
  await runtime.setWriteConfirm(true); // restore for later checks
  await runtime.setWriteMode(false);
  vscodeStub.workspace.workspaceFolders = savedFolders;
  fsmod.rmSync(tmpRoot2, { recursive: true, force: true });
  console.log('  PASS  .py write (createFile/saveText) runs with zero dialogs when confirmWrite=false');

  /* Edge cases reported as "untested" after the manual run:
   * 1. saveText into a missing folder
   * 2. the exact 200 KB readFile boundary
   * 3. insertText's success path (needs an active editor) */
  const tmpEdges = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-edges-'));
  const savedForEdges = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpEdges } }];
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  const edgeCfg = runtime.getConfig();
  const edgeEvents = [];
  const edgeCtx = {
    token: { isCancellationRequested: false },
    emit: function (e) { edgeEvents.push(e); }
  };
  let awaitingEdges = 0;
  const edgeAwaitCtx = {
    token: { isCancellationRequested: false },
    emit: function (e) { if (e && e.type === 'awaiting') { awaitingEdges++; } }
  };

  /* 1. saveText never invents folders, and refuses before asking the user. */
  nextConfirmAnswer = undefined; // any dialog would resolve to "rejected"
  const ghost = await runTool(
    { tool: 'saveText', args: { path: 'ghost/dir/x.txt', text: 'nope' } }, edgeCfg, edgeAwaitCtx);
  assert.ok(/Target directory does not exist/.test(ghost), 'saveText must name the missing folder: ' + ghost);
  assert.ok(/createFile/.test(ghost), 'the error must point at createFile as the fix: ' + ghost);
  assert.strictEqual(fsmod.existsSync(path.join(tmpEdges, 'ghost')), false, 'saveText must not create parent folders');
  assert.strictEqual(awaitingEdges, 0, 'a write that cannot succeed must not ask the user first');
  console.log('  PASS  saveText refuses a missing parent folder up front, names createFile, creates nothing');

  /* 2. 200 KB is a hard inclusive boundary: 204800 bytes pass, 204801 fail. */
  fsmod.writeFileSync(path.join(tmpEdges, 'exact.txt'), 'a'.repeat(200 * 1024), 'utf8');
  const exactRead = await runTool({ tool: 'readFile', args: { path: 'exact.txt' } }, edgeCfg, edgeCtx);
  assert.ok(/^FILE: exact\.txt/.test(exactRead), 'exactly 200 KB must still be readable: ' + exactRead.slice(0, 120));
  assert.ok(!/too large/.test(exactRead), 'exactly 200 KB must not trip the gate');
  assert.ok(exactRead.length < 200 * 1024, 'result must be truncated for the model, not dumped whole');
  fsmod.writeFileSync(path.join(tmpEdges, 'over.txt'), 'a'.repeat(200 * 1024 + 1), 'utf8');
  const overRead = await runTool({ tool: 'readFile', args: { path: 'over.txt' } }, edgeCfg, edgeCtx);
  assert.ok(/File too large \(204801 bytes > 204800\)/.test(overRead),
    'one byte past 200 KB must be refused with exact sizes: ' + overRead);
  console.log('  PASS  readFile boundary is exact: 204800 bytes OK, 204801 bytes refused');

  /* 3. insertText success path with a real (stubbed) editor buffer. */
  const editorPath = path.join(tmpEdges, 'app.js');
  const savedEditor = vscodeStub.window.activeTextEditor;
  let buffer = 'const a = 1;\n';
  vscodeStub.window.activeTextEditor = {
    document: {
      languageId: 'javascript',
      uri: { fsPath: editorPath },
      fileName: editorPath,
      getText: function () { return buffer; }
    },
    selection: { isEmpty: true, end: { line: 1, character: 0 } },
    edit: async function (cb) {
      cb({
        insert: function (pos, text) {
          const lines = buffer.split('\n');
          let offset = 0;
          for (let i = 0; i < pos.line; i++) { offset += lines[i].length + 1; }
          offset += pos.character;
          buffer = buffer.slice(0, offset) + text + buffer.slice(offset);
        },
        replace: function () {},
        delete: function () {}
      });
      return true;
    }
  };
  const inserted = 'console.log(42);\n';
  const insRes = await runTool({ tool: 'insertText', args: { text: inserted } }, edgeCfg, edgeCtx);
  assert.ok(insRes.indexOf('Inserted ' + inserted.length + ' characters') === 0,
    'insertText must report the inserted length: ' + insRes);
  assert.strictEqual(buffer, 'const a = 1;\n' + inserted, 'text must land at the selection end');
  // A rejected / failed edit must not report success.
  vscodeStub.window.activeTextEditor.edit = async function () { return false; };
  const insFail = await runTool({ tool: 'insertText', args: { text: 'x' } }, edgeCfg, edgeCtx);
  assert.ok(/Editor rejected the edit/.test(insFail), 'a failed edit must surface as an error: ' + insFail);
  vscodeStub.window.activeTextEditor = savedEditor;
  console.log('  PASS  insertText writes into the active editor');

  await runtime.setWriteConfirm(true);
  await runtime.setWriteMode(false);
  vscodeStub.workspace.workspaceFolders = savedForEdges;
  fsmod.rmSync(tmpEdges, { recursive: true, force: true });

  /* Repeat guard: a model that keeps repeating the exact same failing call
   * used to flood the chat with identical errors and burn every round. The
   * third identical attempt must be skipped with an explanation. */
  const loopRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-loop-'));
  const savedForLoop = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: loopRoot } }];
  const savedRounds = settings['win7Agent.maxToolRounds'];
  settings['win7Agent.maxToolRounds'] = 6;
  // The setEndpoint test above pointed baseUrl at a dead host; aim it back.
  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  events.length = 0;
  scriptedResponses.length = 0;
  const doomed = '{"tool":"readFile","args":{"path":"../escape.txt"}}';
  scriptedResponses.push(doomed, doomed, doomed, '放弃：路径不允许，改用工作区内相对路径。');
  await viewMessageHandler({ type: 'send', text: '读取 ../escape.txt' });
  const toolResults = events.filter(function (e) { return e.type === 'tool' && e.status && e.status !== 'call'; });
  assert.ok(toolResults.length >= 3, 'three tool results expected, got ' + toolResults.length);
  assert.strictEqual(toolResults.filter(function (e) { return e.status === 'failed'; }).length, 2,
    'only the first two identical calls may actually run');
  const skipped = toolResults.filter(function (e) { return e.status === 'blocked'; }).pop();
  assert.ok(skipped, 'the third identical call must be reported as blocked');
  assert.ok(/already failed 2 times/.test(skipped.text), 'the skip reason must be explicit: ' + skipped.text);
  assert.ok(/Do not repeat it unchanged/.test(skipped.text), 'the model must be told to change the call');
  // A raw exception can carry newlines; the chat must get one line, not a block.
  const failedTexts = toolResults.filter(function (e) { return e.status === 'failed'; })
    .map(function (e) { return String(e.text || ''); });
  assert.ok(failedTexts.length > 0, 'expected at least one failure to inspect');
  assert.ok(failedTexts.every(function (t) { return t.indexOf('\n') === -1; }),
    'a failed call must stay on one line: ' + JSON.stringify(failedTexts));
  assert.ok(failedTexts.every(function (t) { return t.length <= 320; }),
    'a failed call must be capped near 300 chars: ' + failedTexts.map(function (t) { return t.length; }).join(','));
  // UI contract: every tool event carries a status so the chat can label it.
  assert.ok(events.filter(function (e) { return e.type === 'tool'; }).every(function (e) { return !!e.status; }),
    'every tool event must carry a status for the chat renderer');
  const chatJsSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const chatCssSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.ok(chatJsSrc.indexOf('function addToolIssue') >= 0, 'chat must render failures as a readable line');
  assert.ok(chatJsSrc.indexOf('重复 ') >= 0, 'chat must collapse repeated identical failures');
  assert.ok(chatJsSrc.indexOf('文件已存在') >= 0, 'common refusals must have a Chinese label');
  assert.ok(chatCssSrc.indexOf('.msg.tool-fail') >= 0 && chatCssSrc.indexOf('.msg.tool-block') >= 0);
  settings['win7Agent.maxToolRounds'] = savedRounds;
  vscodeStub.workspace.workspaceFolders = savedForLoop;
  fsmod.rmSync(loopRoot, { recursive: true, force: true });
  console.log('  PASS  identical failing calls are capped: the third is skipped with a reason');

  /* v1.8.0 自动经验记忆：报错 → 后来被修好 → 记一条；只在修好之后记，
   * 且要真的进下一次的系统提示词（否则「记忆」只是聊天区的一句话）。
   * 这里用 createFile 制造真实失败：smoke 的 readFile 是桩，永远返回成功。 */
  const lessonRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-lesson-'));
  const savedForLesson = vscodeStub.workspace.workspaceFolders;
  const savedLessonRounds = settings['win7Agent.maxToolRounds'];
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: lessonRoot } }];
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  settings['win7Agent.maxToolRounds'] = 8;
  await runtime.clearLessons();
  assert.strictEqual(runtime.getLessons().length, 0, 'lessons start empty');

  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"one"}}');
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"two"}}');
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"two","overwrite":true}}');
  scriptedResponses.push('覆盖成功，这是最终回答。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '把这个文件改成 two' });
  const learned = runtime.getLessons();
  assert.strictEqual(learned.length, 1, 'one recovered failure leaves exactly one lesson');
  assert.ok(/overwrite/.test(learned[0].text), 'the lesson must say how to fix it: ' + learned[0].text);
  assert.ok(events.some(function (e) { return e.type === 'lesson'; }), 'the user must be told what was memorized');
  const promptWithLesson = runtime.getEffectivePrompt();
  assert.ok(promptWithLesson.indexOf('## 经验教训') !== -1 && promptWithLesson.indexOf(learned[0].text) !== -1,
    'a learned lesson must reach the next system prompt');

  // 只报错、没修好 —— 不能记，否则会把「这次就是跑不通」当成经验。
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"three"}}');
  scriptedResponses.push('没写进去，先停下。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '再写一次同名文件' });
  assert.strictEqual(runtime.getLessons().length, 1, 'an unsolved failure must not be memorized');

  /* 上一轮没修好、这一轮才修好：同一个工具的失败必须能接上。小模型很常见
   * 一次 run 内自愈不了，若失败只存活一轮，多数真实修复都会被丢掉。 */
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"three","overwrite":true}}');
  scriptedResponses.push('这次覆盖成功了。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '继续，用覆盖方式写 three' });
  const afterCrossRound = runtime.getLessons();
  assert.strictEqual(afterCrossRound.length, 1, 'a repeat of the same category must reinforce, not duplicate');
  assert.ok(afterCrossRound[0].hits >= 2, 'the previous round failure must count as solved: ' + JSON.stringify(afterCrossRound[0]));
  const repeatNotice = events.filter(function (e) { return e.type === 'lesson'; }).pop();
  assert.ok(repeatNotice && repeatNotice.repeated === true,
    'a reinforced lesson must be flagged repeated so the UI does not announce it again');

  // 关掉自动学习：同样的「报错→修好」不再新增、也不再提示。
  settings['win7Agent.autoLearn'] = false;
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"four"}}');
  scriptedResponses.push('{"tool":"createFile","args":{"path":"dup.txt","text":"four","overwrite":true}}');
  scriptedResponses.push('这次覆盖成功了。');
  events.length = 0;
  await viewMessageHandler({ type: 'send', text: '关掉自动学习再写一次' });
  assert.strictEqual(runtime.getLessons().length, 1, 'autoLearn=false must stop new lessons');
  assert.ok(!events.some(function (e) { return e.type === 'lesson'; }), 'no lesson notice when learning is off');
  settings['win7Agent.autoLearn'] = true;

  // 管理入口：删掉一条就必须真的从提示词里消失。
  await runtime.removeLesson(0);
  assert.strictEqual(runtime.getLessons().length, 0);
  assert.ok(runtime.getEffectivePrompt().indexOf('## 经验教训') === -1, 'deleting a lesson removes it from the prompt');

  await runtime.setWriteConfirm(true);
  await runtime.setWriteMode(false);
  settings['win7Agent.maxToolRounds'] = savedLessonRounds;
  vscodeStub.workspace.workspaceFolders = savedForLesson;
  fsmod.rmSync(lessonRoot, { recursive: true, force: true });
  console.log('  PASS  a fixed failure becomes a memory (and only when autoLearn is on)');

  /* Two tool calls in one reply: only the first runs, but the model must be
   * told, or it assumes the second was executed as well. */
  events.length = 0;
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"listFiles","args":{}}\n{"tool":"readFile","args":{"path":"README.md"}}');
  scriptedResponses.push('明白，一次只发一个。');
  await viewMessageHandler({ type: 'send', text: '看看工作区有什么' });
  const multiNote = events.filter(function (e) {
    return e.type === 'tool' && /only the first/.test(e.text || '');
  }).pop();
  assert.ok(multiNote, 'the model must be told only the first of two calls ran');
  assert.ok(/2 tool calls/.test(multiNote.text), multiNote.text);
  console.log('  PASS  a reply with two tool calls runs the first and explains why');

  /* Completion check (v1.5.0): the verdict must come from the real trace, not
   * from the model's own claim. Two runs: one that only talks, one that writes. */
  assert.strictEqual(runtime.getConfig().taskCheck, true, 'completion check must be ON by default');
  // setEndpoint's test left baseUrl on a dead host; point it back at the mock.
  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  events.length = 0;
  scriptedResponses.length = 0;
  // v1.11.4: a "talked but did nothing" round is retried up to twice
  // automatically, so the mock has to keep claiming completion three times
  // before the run gives up.
  scriptedResponses.push('已完成，工作区所有文件都复制到 backup 目录了。');
  scriptedResponses.push('已完成，工作区所有文件都复制到 backup 目录了。');
  scriptedResponses.push('已完成，工作区所有文件都复制到 backup 目录了。');
  await viewMessageHandler({ type: 'send', text: '帮我把工作区文件复制到 backup' });
  const retryNotice = events.filter(function (e) { return e.type === 'notice'; }).pop();
  assert.ok(retryNotice, 'the automatic retry must be announced in the chat');
  assert.ok(/你没有调用任何工具/.test(lastMessages.map(function (m) {
    return String(m.content || '');
  }).join('\n')), 'the model must be told to actually run a tool');
  const claimCheck = events.filter(function (e) { return e.type === 'check'; }).pop();
  assert.ok(claimCheck, 'a check event must be emitted for a task-like message');
  assert.strictEqual(claimCheck.level, 'fail', 'zero tool calls + "已完成" must fail the check');
  assert.strictEqual(claimCheck.verdict, 'false-claim');
  assert.ok(/工具调用 0 次/.test(claimCheck.evidence.join(' ')), 'evidence must state that no tool ran');
  const doneIdx = events.map(function (e) { return e.type; }).indexOf('done');
  assert.ok(events.indexOf(claimCheck) < doneIdx, 'the verdict must arrive before "done" so the green flag can be suppressed');

  const checkRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-check-'));
  const savedForCheck = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: checkRoot } }];
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  events.length = 0;
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"createFile","args":{"path":"out/report.txt","text":"hello zsz"}}');
  scriptedResponses.push('已创建 out/report.txt。');
  await viewMessageHandler({ type: 'send', text: '新建 out/report.txt 写上 hello zsz' });
  const realCheck = events.filter(function (e) { return e.type === 'check'; }).pop();
  assert.ok(realCheck, 'a check event must be emitted for the write run');
  assert.strictEqual(realCheck.level, 'ok', 'a verified write must pass the check: ' + JSON.stringify(realCheck));
  assert.strictEqual(realCheck.verdict, 'done');
  assert.ok(realCheck.evidence.join(' ').indexOf('out/report.txt') !== -1, 'evidence must name the written file');
  assert.ok(/本轮已更新|存在/.test(realCheck.evidence.join(' ')), 'evidence must confirm the file on disk');
  assert.ok(fsmod.existsSync(path.join(checkRoot, 'out', 'report.txt')));
  assert.ok(/case 'check'/.test(chatJs) && /function addCheck\(/.test(chatJs), 'webview must render the check card');
  assert.ok(/lastCheck && lastCheck\.level === 'fail'/.test(chatJs), 'a failed check must suppress the green "已完成" flag');
  assert.ok(/\.msg\.check/.test(chatCss) && /chk-tag-fail/.test(chatCss), 'check card styling must exist');
  await runtime.setWriteConfirm(true);
  await runtime.setWriteMode(false);
  vscodeStub.workspace.workspaceFolders = savedForCheck;
  fsmod.rmSync(checkRoot, { recursive: true, force: true });
  console.log('  PASS  completion check flags a false "已完成" and confirms a real write on disk');

  /* Pseudo-streaming (v1.6.0): stream=true must keep the tool loop alive. */
  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  settings['win7Agent.stream'] = true;
  events.length = 0;
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"listFiles","args":{}}');
  scriptedResponses.push('工作区文件清单已经拿到。' + '补充说明。'.repeat(20));
  await viewMessageHandler({ type: 'send', text: '列一下工作区文件' });
  const streamTool = events.filter(function (e) { return e.type === 'tool' && e.status === 'ok'; });
  const streamDeltas = events.filter(function (e) { return e.type === 'delta'; });
  assert.ok(streamTool.length >= 1, 'stream=true must still execute tools: ' + streamTool.length);
  assert.ok(streamDeltas.length > 1, 'the answer must be replayed in slices: ' + streamDeltas.length);
  assert.ok(streamDeltas.map(function (e) { return e.text; }).join('').indexOf('工作区文件清单已经拿到') === 0,
    'the replayed text must match the answer');
  assert.ok(!events.some(function (e) { return /streaming mode/.test(e.text || ''); }),
    'the old "streaming disables tools" warning must be gone');
  settings['win7Agent.stream'] = false;
  console.log('  PASS  stream=true replays the answer in slices and still runs tools');

  /* A transient 503 must be retried instead of killing the whole round. */
  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  failNext = 1;
  events.length = 0;
  scriptedResponses.length = 0;
  scriptedResponses.push('重试成功了。');
  await viewMessageHandler({ type: 'send', text: '今天状态怎么样？' });
  const retryNote = events.filter(function (e) { return e.type === 'notice' && /自动重试/.test(e.text || ''); }).pop();
  assert.ok(retryNote, 'a 503 must be retried and announced');
  assert.ok(events.filter(function (e) { return e.type === 'delta'; })
    .map(function (e) { return e.text; }).join('').indexOf('重试成功了') !== -1, 'the retried answer must arrive');
  assert.strictEqual(events.filter(function (e) { return e.type === 'error'; }).length, 0, 'no error must reach the user');
  console.log('  PASS  a transient 503 is retried automatically and announced');

  const diagRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-diag-'));
  const savedFoldersForDiag = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: diagRoot } }];
  await commands['win7Agent.exportDiagnostics']();
  const diagFiles = fsmod.readdirSync(diagRoot).filter(function (f) { return /^zsz-diagnostics-.*\.txt$/.test(f); });
  assert.strictEqual(diagFiles.length, 1, 'exactly one bundle must be written');
  const bundle = fsmod.readFileSync(path.join(diagRoot, diagFiles[0]), 'utf8');
  assert.ok(bundle.indexOf('诊断包') !== -1, 'the bundle must be self-describing');
  assert.ok(bundle.indexOf('v' + manifest.version) !== -1, 'the bundle must carry the extension version');
  assert.ok(bundle.indexOf('constraints.confirmWrite') !== -1, 'scoped settings must be listed');
  assert.ok(bundle.indexOf('扩展冲突扫描') !== -1, 'the conflict scan must be included');
  vscodeStub.workspace.workspaceFolders = savedFoldersForDiag;
  fsmod.rmSync(diagRoot, { recursive: true, force: true });
  console.log('  PASS  exportDiagnostics writes one self-contained bundle');

  /* A modal nobody answers must NOT hang the run. Before this fix all three
   * confirmation gates awaited showWarningMessage() with no deadline at all. */
  const { confirmWithTimeout, confirmTimeoutMs, CONFIRM_TIMEOUT } = require('../src/agent');
  let noticeCount = 0;
  const never = new Promise(function () {});
  const raceStart = Date.now();
  const raced = await confirmWithTimeout(never, 40, function () { noticeCount++; });
  assert.strictEqual(raced, CONFIRM_TIMEOUT, 'a never-answered dialog must time out instead of hanging');
  assert.strictEqual(noticeCount, 1, 'timeout notice must fire exactly once');
  assert.ok(Date.now() - raceStart < 3000, 'timeout must resolve promptly');
  const answered = await confirmWithTimeout(Promise.resolve('Run'), 40, function () { noticeCount++; });
  assert.strictEqual(answered, 'Run', 'a real answer must win the race');
  assert.strictEqual(noticeCount, 1, 'no timeout notice after a real answer (timer cleared)');
  const broken = await confirmWithTimeout(Promise.reject(new Error('host gone')), 40, function () { noticeCount++; });
  assert.strictEqual(broken, undefined, 'a rejected dialog must resolve, not hang');
  const throwingNotice = await confirmWithTimeout(never, 40, function () { throw new Error('bad notice'); });
  assert.strictEqual(throwingNotice, CONFIRM_TIMEOUT, 'a throwing notice callback must not hang');
  assert.strictEqual(confirmTimeoutMs({ confirmTimeoutMs: 40 }), 40);
  console.log('  PASS  confirmWithTimeout races the modal, clears its timer, survives broken dialogs');

  const timeoutRoot = fsmod.mkdtempSync(path.join(os.tmpdir(), 'zsz-confirm-timeout-'));
  const savedFoldersForTimeout = vscodeStub.workspace.workspaceFolders;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: timeoutRoot } }];
  await runtime.setWriteMode(true);
  const tinyCfg = Object.assign({}, runtime.getConfig(), { confirmTimeoutMs: 50 });
  const timeoutEvents = [];
  const timeoutCtx = { token: { isCancellationRequested: false }, emit: function (e) { timeoutEvents.push(e); } };
  function hungGuard() {
    return new Promise(function (resolve) { setTimeout(function () { resolve('__HUNG__'); }, 5000); });
  }

  // (a) command confirmation: the command must NOT run after a timeout.
  neverResolveWarning = true;
  const cmdStart = Date.now();
  const cmdTimeout = await Promise.race([
    runTool({ tool: 'runCommand', args: { shell: 'cmd', command: 'echo SHOULD_NOT_RUN > should_not_exist.txt' } }, tinyCfg, timeoutCtx),
    hungGuard()
  ]);
  neverResolveWarning = false;
  assert.notStrictEqual(cmdTimeout, '__HUNG__', 'runCommand must not hang on a never-answered dialog');
  assert.ok(/CONFIRM TIMEOUT/.test(cmdTimeout), 'runCommand must report a timeout: ' + cmdTimeout);
  assert.ok(!/STATUS: OK/.test(cmdTimeout), 'the command must NOT have run');
  assert.ok(!fsmod.existsSync(path.join(timeoutRoot, 'should_not_exist.txt')), 'no side effect after timeout');
  assert.ok(Date.now() - cmdStart < 5000, 'runCommand timeout must resolve quickly');
  assert.ok(timeoutEvents.some(function (e) { return e && e.type === 'awaiting'; }), 'yellow awaiting signal comes first');
  assert.ok(timeoutEvents.some(function (e) { return e && e.type === 'awaitTimeout' && /再点也不会执行/.test(e.text); }),
    'timeout notice must explain the VS Code 1.70 modal limitation');

  // (b) write confirmation: createFile routes through confirmWriteAction.
  timeoutEvents.length = 0;
  neverResolveWarning = true;
  const writeTimeout = await Promise.race([
    runTool({ tool: 'createFile', args: { path: 'should_not_exist.py', text: 'print(1)' } }, tinyCfg, timeoutCtx),
    hungGuard()
  ]);
  neverResolveWarning = false;
  assert.notStrictEqual(writeTimeout, '__HUNG__', 'createFile must not hang on a never-answered dialog');
  assert.ok(/CONFIRM TIMEOUT/.test(writeTimeout), 'createFile must report a timeout: ' + writeTimeout);
  assert.ok(!fsmod.existsSync(path.join(timeoutRoot, 'should_not_exist.py')), 'no file may be written after a timeout');
  assert.ok(timeoutEvents.some(function (e) { return e && e.type === 'awaitTimeout'; }), 'write timeout must emit awaitTimeout');

  // (c) tool approval: runAgent's requireToolApproval branch, same bare await.
  // setEndpoint's test above left baseUrl pointing at a dead host; restore the
  // mock server so this run actually reaches the model and hits the approval gate.
  settings['win7Agent.baseUrl'] = 'http://127.0.0.1:' + port + '/v1';
  settings['win7Agent.constraints.requireToolApproval'] = true;
  settings['win7Agent.confirmTimeoutMs'] = 50;
  scriptedResponses.length = 0;
  scriptedResponses.push('{"tool":"listFiles","args":{}}');
  scriptedResponses.push('工具审批超时后的最终回答');
  events.length = 0;
  neverResolveWarning = true;
  const approvalRun = await Promise.race([
    viewMessageHandler({ type: 'send', text: '工具审批超时测试' }),
    hungGuard()
  ]);
  neverResolveWarning = false;
  assert.notStrictEqual(approvalRun, '__HUNG__', 'runAgent must not hang on a never-answered approval dialog');
  assert.ok(events.some(function (e) { return e && e.type === 'awaitTimeout'; }), 'approval timeout must emit awaitTimeout');
  assert.ok(events.some(function (e) { return e && e.type === 'tool' && /tool approval timed out/.test(e.text); }),
    'the model must be told the tool was NOT called');
  assert.ok(events.some(function (e) { return e && e.type === 'delta' && /工具审批超时后的最终回答/.test(e.text); }),
    'the agent must continue and deliver the final answer after a timeout');
  delete settings['win7Agent.constraints.requireToolApproval'];
  delete settings['win7Agent.confirmTimeoutMs'];

  await runtime.setWriteMode(false);
  vscodeStub.workspace.workspaceFolders = savedFoldersForTimeout;
  fsmod.rmSync(timeoutRoot, { recursive: true, force: true });
  console.log('  PASS  never-answered dialogs time out for command, write and tool-approval gates; no action runs');

  /* Editor-area panel: opens beside, reuses the same HTML, shares the session. */
  commands['win7Agent.openChatPanel']();
  assert.strictEqual(createdPanels.length, 1, 'a webview panel must be created');
  assert.strictEqual(createdPanels[0].viewType, 'win7Agent.chatPanel');
  assert.strictEqual(createdPanels[0].column, -2, 'panel must open beside the editor');
  assert.ok(/id="messages"/.test(createdPanels[0].webview.html), 'panel must render chat HTML');
  commands['win7Agent.openChatPanel']();
  assert.strictEqual(createdPanels.length, 1, 'revealing an open panel must not create a duplicate');
  console.log('  PASS  editor-area chat panel opens beside and reuses the chat UI');

  /* CSV/MD export: escaping must keep the answer verbatim inside one cell. */
  const csv = require('../src/fileImport').csvEscape('a,b\n"quoted"');
  assert.strictEqual(csv, '"a,b\n""quoted"""', 'CSV export must double quotes and wrap');
  console.log('  PASS  CSV export escapes commas, quotes and newlines correctly');

  /* @ mention: half/full-width @, CJK/punctuation boundary, always-visible
   * feedback, and host fallback when the first findFiles pass is empty. */
  const mentionJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const mentionCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
  assert.ok(/\[@＠\]/.test(mentionJs), 'mention trigger must accept full-width ＠');
  assert.ok(/\[\^A-Za-z0-9_\.\\-\/@＠\]/.test(mentionJs), 'mention must fire after CJK text but not inside emails');
  assert.ok(/mention-empty/.test(mentionJs) && /mention-empty/.test(mentionCss),
    'an empty/loading hint must be visible instead of a silent no-op');
  assert.ok(/if \(currentMention\) \{ renderMention\(\); \}/.test(mentionJs),
    'host reply must repaint even while the popup is hidden');
  assert.ok(/compositionend/.test(mentionJs), 'IME composition must re-check the @ query');
  const cvSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
  assert.ok(/findFiles\('\*\*\/\*', null, 300\)/.test(cvSrc), 'host must retry without excludes when empty');
  assert.ok(/error: String\(err/.test(cvSrc), 'host must pass the failure reason to the webview');
  console.log('  PASS  @ mention: full-width/CJK trigger, visible hints, host fallback wired');

  /* Fabricated tool transcripts: prompt forbids them, and a zero-tool run that
   * still shows "TOOL RESULT"-style text raises a notice. */
  assert.ok(/不要编造执行记录/.test(require('../src/rules').compileSystemPrompt({
    basePrompt: '', constraints: {}, rules: []
  })), 'system prompt must forbid fabricated tool output');
  assert.ok(/TOOL RESULT\|STATUS:/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8')),
    'agent must detect fake tool transcripts in a run with zero executions');
  console.log('  PASS  fabricated tool transcripts are forbidden and detected');

  ext.deactivate();
  Module._load = originalLoad;
  server.close();
  console.log('\nSmoke test passed against a mocked VS Code 1.70.2 host.');
}

main().catch(function (err) {
  console.error('\nSMOKE TEST FAILED: ' + (err && err.stack ? err.stack : err));
  server.close();
  process.exitCode = 1;
});
