'use strict';

const vscode = require('vscode');
const fs = require('fs');
const manifest = require('../package.json');
const runtime = require('./runtime');
const { runAgent, historyLimit, contextCharLimit, takeRecent } = require('./agent');
const compact = require('./compact');
const snapLib = require('./snapshots');
const fileIndex = require('./fileIndex');
const failure = require('./failure');
const schedulerLib = require('./scheduler');

const EXT_ID = manifest.publisher + '.' + manifest.name;

/* History replay cap. Imported files push their FULL text into the history;
 * replaying that verbatim into a fresh webview would freeze the DOM and cost
 * megabytes of scrollback. The complete text stays in the context either way. */
const REPLAY_MAX_CHARS = 4000;

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
    /* 每轮写入快照（内存，最多 5 轮）：{ id, at, files: [{rel, existed, content}] }。
     * 只存内存：文件内容可能很大，落盘的过期快照重启后反而危险。 */
    this._snapshots = [];
    /* 跨轮失败追踪：key = 会话 id，value = Map（结构见 agent.js pendingFixes）。
     * 小模型常见的「这轮没修好、下一轮才修好」需要能接上，否则经验只在
     * 单次 run 内有效，多数真实修复都会被丢掉。只存内存，不落盘。 */
    this._fixMaps = Object.create(null);
    this._cts = null;
    this._busy = false;
    /* 本轮尚未落进历史的占用：工具结果（宿主从 agent 的 usage 事件得知）与
     * 正在流式生成的回复（按 delta 累加）。进度条要「实时动」，靠的就是这两项；
     * 否则一轮里只在发送和结束各跳一次。 */
    this._liveExtra = 0;
    this._liveReply = 0;
    /* 最小化编辑器标签会销毁 webview。保留本轮已生成的正文，后台运行中
     * 重新打开时先重放历史，再补这一段，不能让用户对着空白面板等。 */
    this._liveReplyText = '';
    this._memoryTimer = null;
    /* 定时任务撞上正在回复时的等待队列：宿主侧排队，这一轮结束立刻接着跑。
     * 前端那条队列是「用户手动打的字」，两者互不干扰。落盘是为了让用户在
     * 面板里撤销/调顺序，重载窗口后待执行任务也不会凭空消失。 */
    this._autoPending = runtime.getPendingRuns();
    this._autoDrainTimer = null;
    this._lastAnswer = '';
    /* @ 引用的文件清单：自己遍历工作区（不依赖搜索索引），带 60s 缓存。
     * 刚打开窗口时 VS Code 的 search provider 往往还没就绪，findFiles 会
     * 返回空/残缺，用户看到的就是「@ 里少了一大半文件」。 */
    this._mentionIndex = fileIndex.createFileIndex(vscode);
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

  /* 某个会话的失败追踪表（懒创建）。会话之间互不干扰，避免 A 会话的报错
   * 被 B 会话的成功调用「顺手记成经验」。 */
  _pendingFixesFor(id) {
    const key = String(id || this._activeId || '');
    if (!this._fixMaps[key]) { this._fixMaps[key] = new Map(); }
    return this._fixMaps[key];
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
    this._replay();
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
    this._replay();
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
    delete this._fixMaps[String(id)];
    if (!this._sessions.length) { this._sessions.push(this._blankSession()); }
    if (wasActive) {
      this._activeId = this._sessions[0].id;
      this._history = this._sessions[0].history;
      this._attachments = [];
      this._lastAnswer = '';
      this._replay();
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

  /* The transcript lives only in the webview DOM: closing the panel (or
   * switching sessions) destroys it. Every fresh attach and every session
   * switch therefore replays the persisted history, or the panel looks
   * empty even though the conversation is still there. */
  _replayItems() {
    return (this._history || []).map((m) => {
      const role = m && m.role === 'assistant' ? 'assistant' : 'user';
      let text = String((m && m.content) || '');
      if (text.length > REPLAY_MAX_CHARS) {
        text = text.slice(0, REPLAY_MAX_CHARS) +
          '\n\n（内容过长，仅显示前 ' + REPLAY_MAX_CHARS + ' 字符；完整内容仍在对话上下文中）';
      }
      const item = { role: role, content: text };
      /* 定时发出去的消息在历史里带 scheduled 时间戳：重开面板后仍能看出
       * 这一轮不是自己打的，而是凌晨两点排的批。 */
      if (m && m.scheduled) { item.scheduled = Number(m.scheduled) || 1; }
      return item;
    });
  }

  /* entry 给定时只发给那个视图：webview 的脚本还没跑起来时广播的 replay
   * 会丢（监听器尚未注册），ready 握手后再定向补一次才不会白屏。 */
  _replay(entry) {
    /* 重放 = 换了会话，记忆条必须跟着换；顺手推一次比在每个调用点重复更省事。 */
    this.postMemory();
    const items = this._replayItems();
    if (entry && entry.webview) {
      try { entry.webview.postMessage({ type: 'replay', items: items }); } catch (e) { /* 视图已销毁 */ }
      return;
    }
    this._post({ type: 'replay', items: items }, false);
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

    const entry = { webview: webview, part: part };
    this._views.push(entry);
    part.onDidDispose(() => {
      const i = this._views.indexOf(entry);
      if (i !== -1) { this._views.splice(i, 1); }
      if (part === this._panel) { this._panel = null; }
    });
    webview.onDidReceiveMessage((msg) => this._onMessage(msg, entry));
    /* 用户也可能从活动栏直接恢复，而不是点底部状态栏。两种入口都要把
     * 「已最小化」状态清掉，否则恢复后底部还留着一个多余的 Agent。 */
    if (typeof part.onDidChangeVisibility === 'function') {
      part.onDidChangeVisibility(() => {
        if (part.visible && typeof this.onRestore === 'function') { this.onRestore(); }
      });
    }

    // Replay order matters: first wipe the DOM and lay down the persisted
    // history, THEN replay queued live-run events so in-flight output
    // continues below the restored transcript.
    this._replay();
    const queued = this._pending;
    this._pending = [];
    queued.forEach((msg) => { this._post(msg, false); });
    this.postState();
    this.postSchedules();
    this.postAutoQueue();

    /* 面板一出现就在后台把文件索引跑起来，用户第一次打 @ 时不用等遍历。
     * 失败无所谓：真打 @ 时会重来一次并把原因显示出来。 */
    this._mentionIndex.collect().catch(function () {});
  }

  /* 换工作区/加文件夹后清单要重算，否则新目录里的文件一直 @ 不到。 */
  invalidateFileIndex() {
    this._mentionIndex.invalidate();
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
        '<button id="minimize" class="iconbtn minimize-toggle" type="button" title="最小化 Agent（任务继续在后台运行；可从底部状态栏恢复）" aria-label="最小化 Agent">−</button>' +
        '<button id="menuToggle" class="iconbtn menu-toggle" title="选项" aria-label="选项" aria-expanded="false">···</button>' +
        '<div id="menu" class="menu" hidden>' +
          '<div class="menu-head"><button id="author" class="menu-author" title="© 2026 ' + info.author + ' · MIT 许可 · 反馈：' + info.email + ' · 点击查看关于">© ' + info.author + ' · MIT · v' + info.version + '</button></div>' +
          '<button id="clear" class="menu-item" title="清空当前对话（屏幕和上下文都清）">清空当前对话</button>' +
          '<button id="keybtn" class="menu-item" title="设置或更换 API Key">设置 API Key</button>' +
          '<button id="rules" class="menu-item" title="管理长期要求">长期要求 (0)</button>' +
          '<button id="lessons" class="menu-item" title="查看/删除自动总结的经验">经验记忆 (0)</button>' +
          '<button id="profiles" class="menu-item" title="多套模型配置一键切换">模型配置</button>' +
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
      /* 记忆条：百分比退到后台，主标题直接说「忘了什么 / 压缩了什么」。
       * 需要看细节时展开下面的清单，逐条给出角色与开头，而不是盯着 100%。 */
      '<div id="membar" class="membar" role="progressbar" aria-label="上下文记忆状态" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<div class="membar-track"><div id="memfill" class="membar-fill"></div></div>' +
        '<span id="memtext" class="membar-text">记忆 —</span>' +
      '</div>\n' +
      '<div id="memdetail" class="memdetail" hidden>' +
        '<button id="memdetailhead" class="memdetail-head" type="button" aria-expanded="false" title="展开 / 收起被遗忘或压缩的内容">' +
          '<span id="memdetailcount" class="memdetail-count">记忆变化</span>' +
          '<span class="sched-caret" aria-hidden="true">▾</span>' +
        '</button>' +
        '<div id="memdetailitems" class="memdetail-items" hidden></div>' +
      '</div>\n' +
      /* 定时任务清单：有任务时常驻在记忆条下方，一眼看见排了什么、下次几点；
       * 没有任务时整条隐藏，不占对话空间。点标题展开/收起，点某条直达管理。 */
      '<div id="schedlist" class="schedlist" hidden>' +
        '<button id="schedhead" class="sched-head" type="button" aria-expanded="false" title="展开 / 收起定时任务清单">' +
          '<span id="schedcount" class="sched-count">定时任务</span>' +
          '<span id="schednext" class="sched-next"></span>' +
          '<span class="sched-caret" aria-hidden="true">▾</span>' +
        '</button>' +
        '<div id="scheditems" class="sched-items" hidden></div>' +
      '</div>\n' +
      /* 到点时主任务还在跑的任务进这里：可撤销、可上移/下移，和上面的
       * 「尚未到点」清单分开，免得用户以为那条任务还没开始。 */
      '<div id="autolist" class="schedlist autolist" hidden>' +
        '<div class="sched-head auto-head">' +
          '<span id="autocount" class="sched-count">定时待执行</span>' +
          '<span id="autonext" class="sched-next">当前回复结束后依次执行</span>' +
        '</div>' +
        '<div id="autoitems" class="sched-items"></div>' +
      '</div>\n' +
      '<div id="messages" aria-live="polite"></div>\n' +
      '<div class="statusbar"><span id="phaseDot" class="pdot"></span><span id="phaseText" class="ptext">就绪</span><span id="timer" class="timer"></span></div>\n' +
      '<div id="progress" class="progress" hidden><div class="bar"></div></div>\n' +
      '<div class="composer">\n' +
      '  <div id="queue" class="queue" hidden></div>\n' +
      '  <div id="attachments" class="attach-bar" hidden aria-label="已导入的文件"></div>\n' +
      '  <textarea id="input" rows="3" placeholder="输入消息；上一条未完成时可直接继续输入，Ctrl+Enter 发送并暂存"></textarea>\n' +
      '  <div class="row"><button id="send" class="primary">Send</button><button id="stop" disabled>Stop</button>' +
        '<button id="schedbtn" title="定时发送：把输入框里的内容排到指定时间执行（内网错峰、夜里跑批）">定时</button>' +
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

  /* 面板顶端的记忆容量条：当前会话历史有多少字符、预算多少、这一轮真正会
   * 送进模型的有几条。上限与裁剪都复用它自己（agent.takeRecent），否则界面
   * 说的容量会和实际送进去的内容对不上。 */
  _memoryState() {
    const config = runtime.getConfig();
    const history = Array.isArray(this._history) ? this._history : [];
    let used = 0;
    let summarized = false;
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (!m || typeof m.content !== 'string') { continue; }
      used += m.content.length;
      if (m.content.indexOf(compact.SUMMARY_MARKER) === 0) { summarized = true; }
    }
    const limit = contextCharLimit(config);
    const msgLimit = historyLimit(config);
    const recent = takeRecent(history, msgLimit, limit);
    /* v1.13.4：容量百分比本身说明不了问题——满格之后永远停在 100%。
     * 真正有用的是「谁被挤出了上下文、谁被压成了摘要」，两者都按消息开头
     * 留一小段，展开就能看，不逼用户悬停一条细进度条猜。 */
    const forgotten = [];
    (Array.isArray(recent.lost) ? recent.lost : []).forEach(function (m) {
      if (!compact.isSummary(m)) { forgotten.push(compact.preview(m)); }
    });
    const compressed = [];
    let compressedCount = 0;
    history.forEach(function (m) {
      if (!compact.isSummary(m)) { return; }
      const carried = Array.isArray(m.compressedItems) ? m.compressedItems : [];
      const count = Number(m.compressedCount);
      compressedCount += Number.isFinite(count) && count > 0 ? count : (carried.length || 1);
      carried.forEach(function (it) {
        if (compressed.length < 12 && it && typeof it.text === 'string') { compressed.push(it); }
      });
      if (!carried.length) {
        compressed.push({ role: '摘要', text: '较早对话（旧版本未保留逐条记录）' });
      }
    });
    /* 这一轮还在跑：工具结果与流式输出已经占着上下文，但还没 push 进 history。
     * 不把它们算进来，进度条就会「一轮只动两次」，看着像坏了。 */
    const live = Math.max(0, (Number(this._liveExtra) || 0) + (Number(this._liveReply) || 0));
    const total = used + live;
    const percent = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0;
    return {
      used: total,
      committed: used,
      live: live,
      limit: limit,
      percent: percent,
      included: recent.chars,
      includedMessages: recent.messages.length,
      messages: history.length,
      messageLimit: msgLimit,
      dropped: recent.dropped,
      forgottenCount: forgotten.length,
      forgotten: forgotten,
      compressedCount: compressedCount,
      compressed: compressed,
      summarized: summarized
    };
  }

  /* 每次 push 历史后只推这一条，不必整套 postState（那要读 Key、拼会话列表）。 */
  postMemory() {
    this._post({ type: 'memory', memory: this._memoryState() }, false);
  }

  /* 流式输出时 delta 来得很快（每几十毫秒一条）：限流 250ms 推一次，既看得见
   * 条在走，也不至于把 message 通道灌满。 */
  _scheduleMemory() {
    if (this._memoryTimer) { return; }
    this._memoryTimer = setTimeout(() => {
      this._memoryTimer = null;
      this.postMemory();
    }, 250);
  }

  /* 本轮上下文增长的两个来源：agent 报的 usage（工具结果等临时消息）、
   * 尚未写完的回复正文（delta 累计）。run 结束时清零，改用落库后的真实值。 */
  _trackMemory(evt) {
    if (!evt || !evt.type) { return; }
    if (evt.type === 'usage') {
      this._liveExtra = Math.max(0, Number(evt.extraChars) || 0);
      this._scheduleMemory();
      return;
    }
    if (evt.type === 'delta') {
      this._liveReply += String(evt.text || '').length;
      this._liveReplyText += String(evt.text || '');
      this._scheduleMemory();
      return;
    }
    /* 新一轮（或另一段回答）从零开始计回复长度，避免上段正文重复计算。 */
    if (evt.type === 'start') {
      this._liveReply = 0;
      this._liveReplyText = '';
      return;
    }
    if (evt.type === 'busy' && evt.value === false) {
      this._liveExtra = 0;
      this._liveReply = 0;
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
      memory: this._memoryState(),
      localEndpoint: config.localEndpoint,
      model: config.model,
      modelNote: runtime.getModelScopeNote(),
      baseUrl: config.baseUrl,
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
      profileCount: runtime.getProfiles().length,
      profileName: runtime.activeProfileName(),
      maxToolRounds: config.maxToolRounds,
      maxHistoryMessages: config.maxHistoryMessages,
      timeoutSec: Math.round(config.timeoutMs / 1000)
    }, false);
  }

  /* 已排定的定时任务：面板顶部常驻一条清单，让用户随时看见「设了什么、
   * 下次几点跑」。格式化全在宿主做（webview 里没有 scheduler 模块），
   * 前端只负责把字符串摆出来——这样倒计时/重复规则的口径和 QuickPick 完全一致。 */
  postSchedules() {
    const now = Date.now();
    const jobs = runtime.getSchedules();
    const items = jobs.map((job) => {
      const when = schedulerLib.describeAt(job.at, now);
      const gap = job.at > now
        ? '（还有 ' + schedulerLib.humanizeGap(job.at - now) + '）'
        : '（已到期）';
      return {
        id: job.id,
        when: when,
        gap: gap,
        repeat: job.kind === schedulerLib.DAILY ? '每天' : '仅一次',
        disabled: job.enabled === false,
        short: schedulerLib.shortText(job.text, 48),
        text: String(job.text || '').replace(/\s+/g, ' ').trim(),
        full: schedulerLib.describe(job, now)
      };
    });
    this._post({ type: 'schedules', items: items }, false);
  }

  /* 到点却赶上主任务还在跑的清单。用 id 标识每条，前端的撤销/排序按钮
   * 把 id 传回来，宿主只对这一条动刀，不会误伤正在执行的那一轮。 */
  postAutoQueue() {
    const items = this._autoPending.map((item) => ({
      id: item.id,
      text: schedulerLib.shortText(item.text, 48),
      full: String(item.text || '').replace(/\s+/g, ' ').trim(),
      at: Number(item.scheduled) || 0,
      when: schedulerLib.fmtClock(item.scheduled || Date.now()) + ' 已到点'
    }));
    this._post({ type: 'autoQueue', items: items }, false);
  }

  prefill(text) {
    this._post({ type: 'prefill', text: text }, true);
  }

  /* 系统级提示（定时任务跳过了、排队了）：面板没开着就先存着，
   * 下次挂载时一起投递，免得「发生了什么」完全没有记录。 */
  notify(text) {
    this._post({ type: 'notice', text: String(text || '') }, true);
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

  /* 撤回某一轮的文件改动：恢复原内容 / 删除新建文件。一次性，撤完即失效。 */
  async _revertSnapshot(id) {
    const idx = this._snapshots.findIndex(function (s) { return s.id === id; });
    if (idx < 0) {
      this._post({ type: 'notice', text: '这份快照已失效（只能撤回最近几轮、且重启后不可撤回）。' }, false);
      return;
    }
    const entry = this._snapshots[idx];
    const root = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
      ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
    if (!root) {
      this._post({ type: 'error', text: '没有打开的工作区文件夹，无法撤回。' }, false);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '撤回这一轮的文件改动？将恢复/删除：' + snapLib.describeFiles(entry.files).join('、'),
      { modal: true },
      '撤回'
    );
    if (answer !== '撤回') { return; }
    const results = snapLib.revert(root, entry.files);
    this._snapshots.splice(idx, 1);
    const okCount = results.filter(function (r) { return r.ok; }).length;
    const bad = results.filter(function (r) { return !r.ok; })
      .map(function (r) { return r.rel + '（' + r.reason + '）'; });
    this._post({ type: 'notice', text: '已撤回本轮改动：' + okCount + '/' + results.length + ' 个文件' +
      (bad.length ? '；失败：' + bad.join('、') : '') }, false);
    runtime.log('snapshot reverted: ' + id + ' -> ' + results.map(function (r) {
      return r.rel + '=' + (r.ok ? r.action : 'FAILED');
    }).join(', '));
  }

  getLastAnswer() { return this._lastAnswer; }

  clearHistory() {
    /* 正在回复时清空：runAgent 手里握着同一个 history 数组，清完它还会把
     * 这一轮的回复 push 进「新对话」，看起来像清空没生效。和切换/删除会话
     * 一致，先让这一轮结束（或点 Stop）。 */
    if (this._busy) {
      this._post({ type: 'notice', text: '正在回复，等这一轮结束（或点 Stop）再清空对话。' }, false);
      return;
    }
    const s = this._findSession(this._activeId);
    if (s) { s.history.length = 0; s.title = '新对话'; s.updatedAt = Date.now(); }
    this._history = s ? s.history : [];
    this._attachments = [];
    this._lastAnswer = '';
    /* 清空对话 = 放弃这条线索，上一轮的失败不该再被下一次成功「顺手」记录。 */
    delete this._fixMaps[String(this._activeId)];
    this._post({ type: 'cleared' }, false);
    this.postMemory();
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

  /* 导入的内容在导入那一刻就已经写进对话历史了，输入框上方那排标签只是
   * 「我刚导入了什么」的临时提示。消息一发出，这份文件就属于上一轮，标签
   * 必须跟着收起——继续挂着会让人以为这条消息还带着附件、或者下次还要再发
   * 一次，也把输入区挤得越来越长。 */
  _consumeAttachments() {
    if (!this._attachments.length) { return; }
    this._attachments = [];
    this._post({ type: 'attachments', items: [] }, false);
  }

  /* busy 同时驱动面板和「最小化后」的底部状态入口。集中变更，避免某条
   * 提前返回的错误路径忘了把「运行中」改回「已结束」。 */
  _setBusy(value) {
    const next = Boolean(value);
    if (this._busy === next) { return; }
    this._busy = next;
    if (typeof this.onBusyChange === 'function') {
      try { this.onBusyChange(next); } catch (e) { runtime.log('minimized status update failed: ' + e); }
    }
  }

  /* 真正的最小化必须交给 workbench：只给 webview 内容加 display:none 只会
   * 留下一片空白，侧栏高度一点也收不回。侧栏直接关闭；编辑器里的聊天标签
   * 没有「最小化」概念，就关掉这个标签。两者都只销毁视图，Agent 循环、
   * 会话历史和定时任务都还在 provider / 扩展宿主里继续。 */
  async _minimize(entry) {
    if (typeof this.onMinimize === 'function') { this.onMinimize(this._busy); }
    try {
      if (entry && entry.part && entry.part === this._panel) {
        entry.part.dispose();
      } else {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
      }
    } catch (err) {
      if (typeof this.onRestore === 'function') { this.onRestore(); }
      runtime.log('minimize failed: ' + (err && err.message ? err.message : err));
      this._post({ type: 'error', text: '最小化失败：' + (err && err.message ? err.message : err) }, false);
    }
  }

  _onMessage(msg, entry) {
    if (!msg || !msg.type) { return; }
    switch (msg.type) {
      case 'ready':
        /* 挂载时那份 replay 常常赶在脚本注册监听之前发出，就此丢掉——表现出来
         * 就是「关掉 VS Code 再打开，看不到刚才的对话」。webview 主动报 ready
         * 说明监听器已就位，这时定向补一次才可靠。正在跑的那一轮也可以重放：
         * 这是全新视图，随后会补发本轮已生成正文，不会清掉旧视图的内容。 */
        this._replay(entry);
        /* 最小化编辑器标签后，Agent 仍在跑。新视图先拿到落库历史，再补上
         * 本轮已生成的片段；后续 delta 会照常接着到达。 */
        if (this._busy && this._liveReplyText) {
          this._postTo(entry, { type: 'start' });
          this._postTo(entry, { type: 'delta', text: this._liveReplyText });
        }
        this.postState();
        /* 定时任务清单和 replay 同理：挂载时那次可能在脚本监听就位前发出而丢失，
         * ready 握手后再定向补一次，刚打开面板就能看到已排定的任务。 */
        this.postSchedules();
        this.postAutoQueue();
        this._postAttachments(entry);
        break;
      case 'mentionQuery':
        return this._sendMentionFiles(entry, !!msg.force);
      case 'dropFiles':
        return this._resolveDrops(Array.isArray(msg.files) ? msg.files : [], entry);
      case 'removeAttachment':
        return this._removeAttachment(String(msg.id || ''), entry);
      case 'lessons':
        vscode.commands.executeCommand('win7Agent.manageLessons');
        break;
      case 'profiles':
        vscode.commands.executeCommand('win7Agent.switchProfile');
        break;
      case 'minimize':
        return this._minimize(entry);
      case 'revertSnapshot':
        return this._revertSnapshot(String(msg.id || ''));
      case 'send':
        return this._handleSend(String(msg.text || ''), entry);
      case 'scheduleDraft':
        /* 面板把输入框里的任务交给宿主，由宿主弹时间选择器（命令也能走同一条路）。 */
        return vscode.commands.executeCommand('win7Agent.scheduleTask', { text: String(msg.text || '') });
      case 'scheduleManage':
        /* 点顶部清单里的某条：直接打开那条任务的操作菜单（带 id 定位）。 */
        return vscode.commands.executeCommand('win7Agent.manageSchedules', { id: String(msg.id || '') });
      case 'scheduleAction':
        /* ↑ / ↓ / ✕：直接执行，不再多弹一层菜单。 */
        return vscode.commands.executeCommand('win7Agent.manageSchedules', {
          id: String(msg.id || ''), action: String(msg.action || '')
        });
      case 'scheduleRefresh':
        return this.postSchedules();
      case 'autoQueueAction':
        return this._autoQueueAction(String(msg.id || ''), String(msg.action || ''));
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
   * 匹配。清单由 fileIndex 自己遍历工作区得到（不依赖搜索索引，也不吃
   * files.exclude），首次打开窗口就是完整的一份；force=true 时跳过缓存。
   * 空结果会把原因带回 webview 显示，避免「打了 @ 毫无反应」的静默失败。 */
  async _sendMentionFiles(entry, force) {
    try {
      const index = await this._mentionIndex.collect(force);
      this._postTo(entry, {
        type: 'mentionFiles',
        files: index.files,
        total: index.files.length,
        truncated: !!index.truncated,
        reason: index.reason || ''
      });
    } catch (err) {
      this._mentionIndex.invalidate();
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
    /* 同一份索引，不再单独跑一遍 findFiles：清单更全，也不用重复遍历。 */
    const index = await this._mentionIndex.collect();
    const lower = name.toLowerCase();
    const hit = index.files.find(function (rel) {
      const rl = rel.toLowerCase();
      return rl === lower || rl.endsWith('/' + lower);
    });
    return hit || name;
  }

  async _handleSend(text, entry, meta) {
    if (!text.trim()) { return; }
    if (this._busy) {
      // Another webview (e.g. the side-by-side panel) may have sent while the
      // shared session is busy. Don't drop the message; hand it back so its
      // own editable queue keeps it.
      this._postTo(entry, { type: 'queueRejected', text: text });
      return;
    }
    /* 先占住 busy，再 await：runtime.getApiKey() 是异步的，旧写法把
     * `_busy = true` 放在两个 await 之后，连点两下发送（或面板 + 边栏同时发）
     * 两边都能通过 busy 检查，最后两轮 runAgent 并行跑、共用同一个 _cts——
     * Stop 只停掉后一轮，前一轮继续写历史，会话就乱了。 */
    this._setBusy(true);
    this._cts = new vscode.CancellationTokenSource();
    const releaseSlot = () => {
      if (this._cts) { this._cts.dispose(); }
      this._cts = null;
      this._setBusy(false);
    };
    let config;
    let apiKey;
    try {
      config = runtime.getConfig();
      apiKey = await runtime.getApiKey();
    } catch (err) {
      releaseSlot();
      this._post({ type: 'error', text: '读取 API Key 失败：' +
        (err && err.message ? err.message : String(err)) }, false);
      this._post({ type: 'done' }, false);
      return;
    }
    if (!apiKey && !config.localEndpoint) {
      releaseSlot();
      this._post({ type: 'error', text: 'This endpoint needs an API key. Click "Set key" first.' }, false);
      /* 也要给一个 done：否则面板会一直以为有任务在飞，排队的下一条永远不发。 */
      this._post({ type: 'done' }, false);
      return;
    }

    /* 定时任务没有 webview 发消息：这一轮的「用户气泡」得由宿主补上，
     * 否则面板里只会看到回答，前提条件凭空消失。 */
    const scheduledAt = meta && meta.scheduled ? Number(meta.scheduled) || Date.now() : 0;
    /* 定时任务多半在夜里无人值守：确认弹窗没人点就等于白等，改为按推荐自动
     * 执行（见 agent.js 的 unattended）。可以用 scheduledUnattended 关掉。 */
    const unattended = Boolean(scheduledAt) && config.scheduledUnattended !== false;
    if (scheduledAt) {
      this._post({ type: 'userMessage', text: text, scheduledAt: scheduledAt }, false);
      this._post({ type: 'notice', text: '[定时] ' + schedulerLib.fmtClock(scheduledAt) +
        ' 的定时任务开始执行' + (unattended ? '（无人值守：需要确认的写入/命令按推荐自动执行）' : '') }, false);
    }

    const userTurn = { role: 'user', content: text };
    if (scheduledAt) { userTurn.scheduled = scheduledAt; }
    this._history.push(userTurn);
    this._touchSessionTitle(text);
    /* 用户这一条已经进历史了，记忆条立刻反映（不必等整轮结束）。 */
    this._liveExtra = 0;
    this._liveReply = 0;
    this.postMemory();
    /* 引入的文件已经在历史里，标签到此为止（「回答结束后还留在输入框」）。 */
    this._consumeAttachments();

    try {
      /* 自动上下文压缩（v1.10）：历史超过 agent 的同款限额时，先把被淘汰的
       * 旧消息摘要成一条，替换进会话历史，长任务不再因硬上限丢开头。失败
       * 静默降级为普通裁剪，绝不影响本轮对话。 */
      try {
        const report = await compact.compactIfNeeded({
          config: config,
          apiKey: apiKey,
          history: this._history,
          token: this._cts.token
        });
        if (report && report.ok) {
          this._saveSessions();
          /* 压缩把旧消息换成了摘要，占用会掉下来——让记忆条当场回落，
           * 用户能看见「空间被腾出来了」，而不是等下一轮才变。 */
          this.postMemory();
          this._post({ type: 'notice', text: '历史较长，已自动压缩：' + report.dropped +
            ' 条旧消息 → 摘要 ' + report.summaryChars + ' 字（保留最近 ' + report.kept + ' 条）' }, false);
        } else if (report && report.error) {
          runtime.log('compaction skipped: ' + report.error);
        }
      } catch (e) {
        runtime.log('compaction failed (ignored): ' + (e && e.message ? e.message : String(e)));
      }

      const snap = [];
      const reply = await runAgent({
        config: config,
        apiKey: apiKey || '',
        history: this._history,
        token: this._cts.token,
        unattended: unattended,
        rules: { memoryRules: runtime.getMemoryRules(), lessons: runtime.getLessons() },
        autoLearn: config.autoLearn,
        /* 跨轮复用同一份失败追踪表，让「上一轮报错、这一轮才修好」也能
         * 沉淀成经验（只认同一工具的成功，换话题不会误记）。 */
        pendingFixes: this._pendingFixesFor(this._activeId),
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
        onEvent: (evt) => {
          this._trackMemory(evt);
          this._post(evt, false);
        },
        snapshots: snap
      });
      this._history.push({ role: 'assistant', content: reply });
      this._lastAnswer = reply;
      /* 本轮有真实写入 → 生成可撤回条目发给面板。 */
      if (snap.length) {
        const entry = { id: 'snap-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36), at: Date.now(), files: snap.slice() };
        this._snapshots.unshift(entry);
        while (this._snapshots.length > 5) { this._snapshots.pop(); }
        this._post({ type: 'snapshot', id: entry.id, files: snapLib.describeFiles(entry.files) }, false);
      }
    } catch (err) {
      const text = err && err.message ? err.message : String(err);
      /* 失败带类型：面板据此决定排队的下一条要不要接着发。超时（模型服务
       * 慢 / 刚加载 / 网络抖动）和这一轮任务本身无关，队列继续；
       * 认证、地址、用户 Stop 之类继续发只会同样失败，仍然暂停。 */
      const kind = failure.classify(text);
      runtime.log('runAgent failed (' + kind + '): ' + text);
      this._post({ type: 'error', text: text, kind: kind, queueSafe: failure.queueSafe(kind) }, false);
    } finally {
      if (this._cts) { this._cts.dispose(); }
      this._cts = null;
      this._setBusy(false);
      /* 本轮结束：临时占用要么已经落进 history（assistant 回复），要么被丢弃
       * （失败的中途工具结果），继续挂在进度条上就是虚高。 */
      if (this._memoryTimer) { clearTimeout(this._memoryTimer); this._memoryTimer = null; }
      this._liveExtra = 0;
      this._liveReply = 0;
      this._liveReplyText = '';
      // The webview starts the next queued item on 'done', so clear the host
      // guard first to avoid a fast round-trip being rejected as "busy".
      this._post({ type: 'done' }, false);
      // 这一轮可能追加了 assistant/tool 消息：落盘并刷新会话列表里的条数。
      this._publishSessions();
      this._saveSessions();
      // A run may have written files or toggled switches: refresh the UI state.
      this.postState();
      /* 这一轮结束后，把等待中的定时任务接上（错峰时连排两三条很常见）。 */
      this._drainAutoQueue();
    }
  }

  /* ---- scheduled tasks ---- */

  /* 到点了：没在回复就立刻跑，正在回复就排队等这一轮结束。 */
  runScheduled(text, meta) {
    const body = String(text || '');
    if (!body.trim()) { return Promise.resolve(false); }
    const info = { scheduled: (meta && meta.at) || Date.now() };
    if (this._busy) {
      const item = {
        id: 'q' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36),
        text: body,
        scheduled: info.scheduled,
        queuedAt: Date.now()
      };
      this._autoPending.push(item);
      runtime.savePendingRuns(this._autoPending);
      this.postAutoQueue();
      this._post({ type: 'notice', text: '[定时] 正在回复中，定时任务已排队，这一轮结束立即执行（等待 ' +
        this._autoPending.length + ' 条；可在面板上撤销 / 调顺序）' }, false);
      return Promise.resolve(false);
    }
    return this._handleSend(body, null, info);
  }

  /* 面板上的撤销 / 上移 / 下移：只改宿主里的待执行队列，再落盘 + 重推。 */
  _autoQueueAction(id, action) {
    const i = this._autoPending.findIndex((item) => item.id === id);
    if (i < 0) { return; }
    let verb = '';
    if (action === 'remove') {
      this._autoPending.splice(i, 1);
      verb = '已撤销';
    } else if (action === 'up' && i > 0) {
      const prev = this._autoPending[i - 1];
      this._autoPending[i - 1] = this._autoPending[i];
      this._autoPending[i] = prev;
      verb = '已上移';
    } else if (action === 'down' && i < this._autoPending.length - 1) {
      const next = this._autoPending[i + 1];
      this._autoPending[i + 1] = this._autoPending[i];
      this._autoPending[i] = next;
      verb = '已下移';
    } else {
      return;
    }
    runtime.savePendingRuns(this._autoPending);
    this.postAutoQueue();
    this._post({ type: 'notice', text: '[定时] 待执行任务' + verb }, false);
  }

  _drainAutoQueue() {
    if (this._busy || !this._autoPending.length || this._autoDrainTimer) { return; }
    const self = this;
    /* 让 finally 里的 done / state 先落到 webview，再起下一轮。 */
    this._autoDrainTimer = setTimeout(function () {
      self._autoDrainTimer = null;
      /* 这 60ms 里用户可能又发了一条，或撤销/重排了队列：重新检查再出手。 */
      if (self._busy || !self._autoPending.length) { return; }
      const next = self._autoPending[0];
      self._autoPending.shift();
      runtime.savePendingRuns(self._autoPending);
      self.postAutoQueue();
      self._handleSend(next.text, null, { scheduled: next.scheduled }).catch(function (e) {
        runtime.log('queued scheduled run failed: ' + (e && e.message ? e.message : e));
      });
    }, 60);
  }

  dispose() {
    if (this._autoDrainTimer) { clearTimeout(this._autoDrainTimer); this._autoDrainTimer = null; }
    if (this._cts) { this._cts.cancel(); this._cts.dispose(); }
  }
}

module.exports = { ChatViewProvider };
