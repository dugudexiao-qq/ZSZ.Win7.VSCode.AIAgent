'use strict';

const vscode = require('vscode');
const fs = require('fs');
const manifest = require('../package.json');
const runtime = require('./runtime');
const { runAgent } = require('./agent');

const EXT_ID = manifest.publisher + '.' + manifest.name;

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

class ChatViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._views = [];       // every attached webview (sidebar + editor panels)
    this._panel = null;     // the single editor-area panel, if open
    /* 会话列表：每项 { id, title, updatedAt, history }。_history 始终指向当前会话的
     * history 数组（引用），所以发送/追加/清空都作用在同一个数组上，切换只是换引用。 */
    const saved = runtime.getSessions();
    this._sessions = saved.items.slice();
    if (!this._sessions.length) { this._sessions.push(this._blankSession()); }
    this._activeId = saved.activeId;
    if (!this._sessions.some((s) => s.id === this._activeId)) { this._activeId = this._sessions[0].id; }
    this._history = this._findSession(this._activeId).history;
    this._pending = [];
    this._attachments = [];  // imported files shown above the input box
    this._cts = null;
    this._busy = false;
    this._lastAnswer = '';
  }

  /* ---- conversation sessions ---- */

  _blankSession() {
    return {
      id: 's' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36),
      title: '新对话',
      updatedAt: Date.now(),
      history: []
    };
  }

  _findSession(id) {
    for (let i = 0; i < this._sessions.length; i++) {
      if (this._sessions[i].id === id) { return this._sessions[i]; }
    }
    return null;
  }

  _sessionItems() {
    const active = this._activeId;
    return this._sessions.map(function (s) {
      return { id: s.id, title: s.title, count: s.history.length, updatedAt: s.updatedAt, active: s.id === active };
    });
  }

  /* 只发列表与当前会话，屏幕内容由 webview 自己按会话保存快照后恢复。 */
  _publishSessions() {
    this._post({
      type: 'sessions',
      items: this._sessionItems(),
      activeId: this._activeId,
      count: this._history.length
    }, true);
  }

  _saveSessions() {
    runtime.saveSessions({ activeId: this._activeId, items: this._sessions });
  }

  newSession() {
    if (this._busy) {
      this._post({ type: 'notice', text: '正在回复，等这一轮结束再新开对话。' }, false);
      return;
    }
    const s = this._blankSession();
    this._sessions.unshift(s);
    while (this._sessions.length > runtime.MAX_SESSIONS) { this._sessions.pop(); }
    this._activeId = s.id;
    this._history = s.history;
    this._attachments = [];
    this._lastAnswer = '';
    this._publishSessions();
    this._saveSessions();
  }

  switchSession(id) {
    if (this._busy) {
      this._post({ type: 'notice', text: '正在回复，等这一轮结束再切换对话。' }, false);
      return;
    }
    const s = this._findSession(id);
    if (!s || s.id === this._activeId) { return; }
    this._activeId = s.id;
    this._history = s.history;
    this._attachments = [];
    this._lastAnswer = '';
    this._publishSessions();
    this._saveSessions();
  }

  /* 删掉一个对话。删的是当前对话就切到列表里剩下的第一个；只剩这一个时
   * 不把列表清空，而是换成新的空白对话（否则列表空了没地方可去）。 */
  deleteSession(id) {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx < 0) { return; }
    if (this._busy && id === this._activeId) {
      this._post({ type: 'notice', text: '正在回复，等这一轮结束再删除当前对话。' }, false);
      return;
    }
    const wasActive = id === this._activeId;
    this._sessions.splice(idx, 1);
    if (!this._sessions.length) { this._sessions.push(this._blankSession()); }
    if (wasActive) {
      this._activeId = this._sessions[0].id;
      this._history = this._sessions[0].history;
      this._attachments = [];
      this._lastAnswer = '';
    }
    this._publishSessions();
    this._saveSessions();
  }

  /* 首条消息当会话名，列表里才认得出是哪一轮对话。 */
  _touchSessionTitle(text) {
    const s = this._findSession(this._activeId);
    if (!s) { return; }
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean && (!s.title || s.title === '新对话')) { s.title = clean.slice(0, 28); }
    s.updatedAt = Date.now();
    this._saveSessions();
  }

  /* Shared attach path for the sidebar WebviewView and editor WebviewPanel.
   * Both render the same HTML and drive the same conversation session. */
  _attach(part) {
    const webview = part.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };
    webview.html = this._getHtml(webview);

    const entry = { webview: webview };
    this._views.push(entry);
    part.onDidDispose(() => {
      const i = this._views.indexOf(entry);
      if (i !== -1) { this._views.splice(i, 1); }
      if (part === this._panel) { this._panel = null; }
    });
    webview.onDidReceiveMessage((msg) => this._onMessage(msg, entry));

    const queued = this._pending;
    this._pending = [];
    queued.forEach((msg) => { this._post(msg, false); });
    this.postState();
  }

  resolveWebviewView(webviewView) {
    this._attach(webviewView);
  }

  /* Open a second chat surface in the editor area so the chat can sit beside
   * the file explorer (or any editor) instead of sharing the sidebar. */
  showEditorPanel() {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    if (typeof vscode.window.createWebviewPanel !== 'function') {
      vscode.window.showErrorMessage('当前 VS Code 不支持在编辑器区域打开面板。');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'win7Agent.chatPanel',
      'ZSZ AI Agent · 对话',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
      }
    );
    this._panel = panel;
    this._attach(panel);
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /* ---- webview 资源缓存穿透（v1.9.1）----
   * VS Code 1.70 的 webview 会按 URL 缓存脚本；升级时如果只覆盖同名文件夹
   * （或只重载窗口），协议层/Chromium 缓存可能仍回旧脚本，用户看到的就还是
   * 旧界面。给脚本/样式 URL 附上「版本号-构建时间戳」查询参数，文件一换
   * URL 就变，缓存自然失效。协议处理器只取 URI.path 解析文件路径，
   * query 不影响加载。 */
  _mediaStamp() {
    if (!this._mediaStampCache) {
      let stamp = manifest.version;
      try {
        const st = fs.statSync(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js').fsPath);
        stamp = manifest.version + '-' + Math.floor(st.mtimeMs);
      } catch (e) { /* 读不到就用版本号兜底 */ }
      this._mediaStampCache = stamp;
    }
    return this._mediaStampCache;
  }

  _getHtml(webview) {
    const nonce = makeNonce();
    const info = runtime.getExtensionInfo();
    const stamp = '?v=' + this._mediaStamp();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')) + stamp;
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')) + stamp;
    const mdUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'markdown.js')) + stamp;
    const appName = info.name;
    return '<!DOCTYPE html>\n' +
      '<html lang="zh-CN">\n' +
      '<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<link href="' + cssUri + '" rel="stylesheet">\n' +
      '<title>' + appName + '</title>\n' +
      '</head>\n' +
      '<body>\n' +
      '<div class="hdr">' +
        '<span class="title" title="' + appName + '">ZSZ · AI Agent</span>' +
        '<span id="keystate" class="badge" title="点击查看连接诊断">checking</span>' +
        '<button id="menuToggle" class="iconbtn menu-toggle" title="选项" aria-label="选项" aria-expanded="false">···</button>' +
        '<div id="menu" class="menu" hidden>' +
          '<div class="menu-head"><button id="author" class="menu-author" title="© 2026 ' + info.author + ' · MIT 许可 · 反馈：' + info.email + ' · 点击查看关于">© ' + info.author + ' · MIT · v' + info.version + '</button></div>' +
          '<button id="clear" class="menu-item" title="清空当前对话（屏幕和上下文都清）">清空当前对话</button>' +
          '<button id="keybtn" class="menu-item" title="设置或更换 API Key">设置 API Key</button>' +
          '<button id="rules" class="menu-item" title="管理长期要求">长期要求 (0)</button>' +
          '<button id="lessons" class="menu-item" title="查看/删除自动总结的经验">经验记忆 (0)</button>' +
          '<div class="menu-sep"></div>' +
          '<button id="panelbtn" class="menu-item" title="在编辑器区域打开独立聊天窗">在新面板打开</button>' +
          '<button id="endpoint" class="menu-item" title="设置服务地址 / 端口">服务地址 / 端口</button>' +
          '<button id="settings" class="menu-item" title="打开插件设置">插件设置</button>' +
        '</div>' +
        /* 4 个运行开关：文字写清状态（只读/可写、开/关），不用图标——
         * 图标要额外记住含义，文字直接可读。放在标题下方第二行，
         * 窄面板时自动换行，不会把标题挤掉。 */
        '<span class="flags" role="group" aria-label="运行选项">' +
          '<button id="flagWrite" class="flag" type="button" aria-pressed="false" title="写入模式：只读（Agent 不能改文件，点击允许写入）">写入：只读</button>' +
          '<button id="flagWriteConfirm" class="flag" type="button" aria-pressed="true" title="写入确认：开（每次写文件前先问你，点击关闭）">写入确认：开</button>' +
          '<button id="flagShellConfirm" class="flag" type="button" aria-pressed="true" title="命令确认：开（每条命令执行前先问你，点击关闭）">命令确认：开</button>' +
          '<button id="flagSubtask" class="flag" type="button" aria-pressed="false" title="子任务模式：关（点击允许把独立子任务交给子代理）">子任务：关</button>' +
        '</span>' +
      '</div>\n' +
      '<div id="messages" aria-live="polite"></div>\n' +
      '<div class="statusbar"><span id="phaseDot" class="pdot"></span><span id="phaseText" class="ptext">就绪</span><span id="timer" class="timer"></span></div>\n' +
      '<div id="progress" class="progress" hidden><div class="bar"></div></div>\n' +
      '<div class="composer">\n' +
      '  <div id="queue" class="queue" hidden></div>\n' +
      '  <div id="attachments" class="attach-bar" hidden aria-label="已导入的文件"></div>\n' +
      '  <textarea id="input" rows="3" placeholder="输入消息；上一条未完成时可直接继续输入，Ctrl+Enter 发送并暂存"></textarea>\n' +
      '  <div class="row"><button id="send" class="primary">Send</button><button id="stop" disabled>Stop</button>' +
        '<button id="importbtn" title="导入文件作为本轮上下文">Import</button>' +
        '<button id="exportbtn" title="把上一条回答保存成文件（.md / .csv / .txt）">Save</button>' +
        /* 会话切换：原生 select 在 Win7 上是系统控件，配色跟主题对不上，
         * 改成按钮 + 自绘列表（向上弹出，显示标题 / 时间，可删除）。
         * 按钮只写「切换对话」，不放会话名——会话名长短不一会把按钮撑宽，
         * 窄面板里直接挤到换行；当前是哪个，列表里有 ✓ 标着。 */
        '<span class="sess-wrap">' +
          '<button id="sessionBtn" class="sess-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="切换 / 新建 / 删除对话">' +
            '<span class="sess-label">切换对话</span><span class="sess-caret" aria-hidden="true">▾</span>' +
          '</button>' +
          '<div id="sessionMenu" class="sess-menu" role="listbox" aria-label="对话列表" hidden></div>' +
        '</span></div>\n' +
      '</div>\n' +
      '<script nonce="' + nonce + '" src="' + mdUri + '"></script>\n' +
      '<script nonce="' + nonce + '" src="' + jsUri + '"></script>\n' +
      '</body>\n' +
      '</html>';
  }

  _post(msg, queueIfHidden) {
    if (this._views.length) {
      this._views.forEach(function (entry) { entry.webview.postMessage(msg); });
    } else if (queueIfHidden) {
      this._pending.push(msg);
    }
  }

  async postState() {
    const key = await runtime.getApiKey();
    const config = runtime.getConfig();
    const info = runtime.getExtensionInfo();
    const summary = runtime.getRuleSummary();
    this._post({
      type: 'state',
      hasKey: Boolean(key),
      localEndpoint: config.localEndpoint,
      model: config.model,
      baseUrl: config.baseUrl,
      allowWrite: config.allowWrite,
      author: info.author,
      email: info.email,
      version: info.version,
      target: info.target,
      appName: info.name,
      ruleCount: summary.total,
      memoryCount: summary.memoryCount,
      lessonCount: summary.lessonCount,
      autoLearn: summary.autoLearn,
      readOnly: summary.constraints.readOnly,
      sessions: this._sessionItems(),
      activeId: this._activeId,
      writeMode: runtime.isWriteMode(),
      shellConfirm: runtime.isShellConfirm(),
      writeConfirm: config.constraints.confirmWrite === true,
      allowShell: summary.constraints.allowShell,
      subtaskMode: config.subtaskMode === true,
      maxToolRounds: config.maxToolRounds,
      maxHistoryMessages: config.maxHistoryMessages,
      timeoutSec: Math.round(config.timeoutMs / 1000)
    }, false);
  }

  prefill(text) {
    this._post({ type: 'prefill', text: text }, true);
  }

  /* Used by the Import File command: put the file into the conversation and
   * show a compact chip in the transcript (the full text is not re-rendered).
   * The same import is also listed above the input box as a removable chip, so
   * the user can see what is currently attached without scrolling back. */
  addContextMessage(content, label, meta) {
    const info = meta && typeof meta === 'object' ? meta : {};
    const id = 'att-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    this._history.push({ role: 'user', content: content });
    this._attachments.push({
      id: id,
      name: info.name || String(label || '已导入文件'),
      kind: String(info.kind || ''),
      chars: Number(info.chars) || 0,
      truncated: Boolean(info.truncated)
    });
    this._post({ type: 'file', text: label, path: String(info.name || '') }, true);
    this._post({
      type: 'attachment',
      item: {
        id: id,
        name: info.name || String(label || '已导入文件'),
        kind: String(info.kind || ''),
        chars: Number(info.chars) || 0,
        truncated: Boolean(info.truncated)
      }
    }, true);
  }

  getAttachments() { return this._attachments.slice(); }

  /* 取消一条导入：从对话历史里摘掉对应的上下文内容，输入框上方的标签同步消失。
   * 这样「移除标签」不是纯视觉操作——模型下一轮真的看不到那份文件了。 */
  _removeAttachment(id, entry) {
    const idx = this._attachments.findIndex(function (a) { return a.id === id; });
    if (idx < 0) { return; }
    const item = this._attachments[idx];
    this._attachments.splice(idx, 1);
    const marker = '以下是我导入的文件《' + item.name + '》';
    for (let i = this._history.length - 1; i >= 0; i--) {
      const m = this._history[i];
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content.indexOf(marker) === 0) {
        this._history.splice(i, 1);
        break;
      }
    }
    this._post({ type: 'attachmentRemoved', id: id }, false);
  }

  getLastAnswer() { return this._lastAnswer; }

  clearHistory() {
    const s = this._findSession(this._activeId);
    if (s) { s.history.length = 0; s.title = '新对话'; s.updatedAt = Date.now(); }
    this._history = s ? s.history : [];
    this._attachments = [];
    this._lastAnswer = '';
    this._post({ type: 'cleared' }, false);
    this._publishSessions();
    this._saveSessions();
  }

  _postTo(entry, msg) {
    if (entry && entry.webview) { entry.webview.postMessage(msg); }
    else { this._post(msg, false); }
  }

  /* A reopened sidebar/panel must still show what is attached. */
  _postAttachments(entry) {
    if (!this._attachments.length) { return; }
    this._postTo(entry, { type: 'attachments', items: this._attachments.slice() });
  }

  _onMessage(msg, entry) {
    if (!msg || !msg.type) { return; }
    switch (msg.type) {
      case 'ready':
        this.postState();
        this._postAttachments(entry);
        break;
      case 'mentionQuery':
        this._sendMentionFiles(entry);
        break;
      case 'dropFiles':
        return this._resolveDrops(Array.isArray(msg.files) ? msg.files : [], entry);
      case 'removeAttachment':
        return this._removeAttachment(String(msg.id || ''), entry);
      case 'lessons':
        vscode.commands.executeCommand('win7Agent.manageLessons');
        break;
      case 'send':
        return this._handleSend(String(msg.text || ''), entry);
      case 'stop':
        if (this._cts) { this._cts.cancel(); }
        break;
      case 'clear':
        this.clearHistory();
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'switchSession':
        this.switchSession(String(msg.id || ''));
        break;
      case 'deleteSession':
        this.deleteSession(String(msg.id || ''));
        break;
      case 'setKey':
        vscode.commands.executeCommand('win7Agent.setApiKey');
        break;
      case 'diagnose':
        vscode.commands.executeCommand('win7Agent.diagnose');
        break;
      case 'about':
        vscode.commands.executeCommand('win7Agent.about');
        break;
      case 'rules':
        vscode.commands.executeCommand('win7Agent.manageRules');
        break;
      case 'endpoint':
        vscode.commands.executeCommand('win7Agent.setEndpoint');
        break;
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + EXT_ID + ' win7Agent');
        break;
      case 'writeMode':
        vscode.commands.executeCommand('win7Agent.toggleWriteMode');
        break;
      case 'shellConfirm':
        vscode.commands.executeCommand('win7Agent.toggleShellConfirm');
        break;
      case 'writeConfirm':
        vscode.commands.executeCommand('win7Agent.toggleWriteConfirm');
        break;
      case 'subtaskMode':
        vscode.commands.executeCommand('win7Agent.toggleSubtaskMode');
        break;
      case 'openPanel':
        vscode.commands.executeCommand('win7Agent.openChatPanel');
        break;
      case 'import':
        vscode.commands.executeCommand('win7Agent.importFile');
        break;
      case 'export':
        vscode.commands.executeCommand('win7Agent.exportAnswer');
        break;
      default:
        break;
    }
  }

  /* @ 引用：用户在输入框打出 @ 时，webview 请求一份工作区文件清单做模糊
   * 匹配。清单按相对路径返回，供输入框内直接选用。
   * 空结果时放宽一次（去掉排除规则），仍为空就把原因带回 webview 显示，
   * 避免「打了 @ 毫无反应」这种无从判断的静默失败。 */
  async _sendMentionFiles(entry) {
    try {
      let uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.agent-selftest}/**', 300);
      if (!uris.length) {
        uris = await vscode.workspace.findFiles('**/*', null, 300);
      }
      const files = uris.map(function (u) { return vscode.workspace.asRelativePath(u, false); })
        .filter(function (p) { return !!p; });
      files.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : (a.toLowerCase() > b.toLowerCase() ? 1 : 0); });
      this._postTo(entry, { type: 'mentionFiles', files: files });
    } catch (err) {
      this._postTo(entry, {
        type: 'mentionFiles',
        files: [],
        error: String(err && err.message ? err.message : err)
      });
    }
  }

  /* 拖拽文件 → @引用。每个文件解析成工作区相对路径：
   * ① webview 带来绝对路径（Electron 的 File.path）且在工作区内 → 直接转；
   * ② 否则按文件名在清单里做后缀匹配（拖进来的可能是桌面路径）；
   * ③ 都找不到就原样用文件名，模型 readFile 失败时自己会报告。 */
  async _resolveDrops(files, entry) {
    const tokens = [];
    for (let i = 0; i < files.length; i++) {
      try { tokens.push(await this._resolveDrop(files[i])); }
      catch (err) { tokens.push(String(files[i] && files[i].name) || ''); }
    }
    this._postTo(entry, { type: 'dropResolved', tokens: tokens });
  }

  async _resolveDrop(f) {
    const raw = String((f && f.path) || '');
    if (raw && /[\\/]/.test(raw)) {
      try {
        const rel = vscode.workspace.asRelativePath(vscode.Uri.file(raw), false);
        // 工作区外 asRelativePath 会退回绝对路径或带 .. ——一律不接受
        if (rel && rel.indexOf('..') !== 0 && !/^[A-Za-z]:[\\/]/.test(rel) && !/^\\\\/.test(rel)) {
          return rel.replace(/\\/g, '/');
        }
      } catch (err) { /* 继续按文件名找 */ }
    }
    const name = String((f && f.name) || '').trim();
    if (!name) { return ''; }
    let uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.agent-selftest}/**', 300);
    if (!uris.length) {
      uris = await vscode.workspace.findFiles('**/*', null, 300);
    }
    const lower = name.toLowerCase();
    let hit = null;
    for (const u of uris) {
      const rel = vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/');
      const rl = rel.toLowerCase();
      if (rl === lower || rl.endsWith('/' + lower)) { hit = rel; break; }
    }
    return hit || name;
  }

  async _handleSend(text, entry) {
    if (!text.trim()) { return; }
    if (this._busy) {
      // Another webview (e.g. the side-by-side panel) may have sent while the
      // shared session is busy. Don't drop the message; hand it back so its
      // own editable queue keeps it.
      this._postTo(entry, { type: 'queueRejected', text: text });
      return;
    }
    const config = runtime.getConfig();
    const apiKey = await runtime.getApiKey();
    if (!apiKey && !config.localEndpoint) {
      this._post({ type: 'error', text: 'This endpoint needs an API key. Click "Set key" first.' }, false);
      return;
    }

    this._busy = true;
    this._cts = new vscode.CancellationTokenSource();
    this._history.push({ role: 'user', content: text });
    this._touchSessionTitle(text);

    try {
      const reply = await runAgent({
        config: config,
        apiKey: apiKey || '',
        history: this._history,
        token: this._cts.token,
        rules: { memoryRules: runtime.getMemoryRules(), lessons: runtime.getLessons() },
        autoLearn: config.autoLearn,
        /* 工具报错后被修好 → 沉淀成一条长期经验。渲染在这里做：宿主持久化成功后
         * 才往聊天区发提示，用户能看到「记住了什么」，而不是悄悄改提示词。 */
        onLesson: async (lesson) => {
          const saved = await runtime.addLesson(lesson);
          if (!saved || !saved.ok) { return; }
          this._post({
            type: 'lesson',
            text: saved.text,
            id: lesson && lesson.id,
            count: saved.count,
            repeated: Boolean(saved.repeated)
          }, false);
        },
        onEvent: (evt) => { this._post(evt, false); }
      });
      this._history.push({ role: 'assistant', content: reply });
      this._lastAnswer = reply;
    } catch (err) {
      runtime.log('runAgent failed: ' + (err && err.message ? err.message : String(err)));
      this._post({ type: 'error', text: err && err.message ? err.message : String(err) }, false);
    } finally {
      if (this._cts) { this._cts.dispose(); }
      this._cts = null;
      this._busy = false;
      // The webview starts the next queued item on 'done', so clear the host
      // guard first to avoid a fast round-trip being rejected as "busy".
      this._post({ type: 'done' }, false);
      // 这一轮可能追加了 assistant/tool 消息：落盘并刷新会话列表里的条数。
      this._publishSessions();
      this._saveSessions();
      // A run may have written files or toggled switches: refresh the UI state.
      this.postState();
    }
  }

  dispose() {
    if (this._cts) { this._cts.cancel(); this._cts.dispose(); }
  }
}

module.exports = { ChatViewProvider };
