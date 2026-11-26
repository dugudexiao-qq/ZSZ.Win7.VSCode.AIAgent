(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var phaseText = document.getElementById('phaseText');
  var phaseDot = document.getElementById('phaseDot');
  var timerEl = document.getElementById('timer');
  var progressEl = document.getElementById('progress');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var clearBtn = document.getElementById('clear');
  var keyBtn = document.getElementById('keybtn');
  var importBtn = document.getElementById('importbtn');
  var exportBtn = document.getElementById('exportbtn');
  var settingsBtn = document.getElementById('settings');
  var endpointBtn = document.getElementById('endpoint');
  var keyState = document.getElementById('keystate');
  var memBar = document.getElementById('membar');
  var memFill = document.getElementById('memfill');
  var memText = document.getElementById('memtext');
  var authorBtn = document.getElementById('author');
  var rulesBtn = document.getElementById('rules');
  var lessonsBtn = document.getElementById('lessons');
  var profilesBtn = document.getElementById('profiles');
  var schedBtn = document.getElementById('schedbtn');
  var attachEl = document.getElementById('attachments');
  /* 标题旁的 4 个运行开关（写入模式 / 写入确认 / 命令确认 / 子任务）。
   * 常看常切，所以常驻图标 + 悬停说明，状态变化只改图标与 class。 */
  var flagWrite = document.getElementById('flagWrite');
  var flagWriteConfirm = document.getElementById('flagWriteConfirm');
  var flagShellConfirm = document.getElementById('flagShellConfirm');
  var flagSubtask = document.getElementById('flagSubtask');
  var sessionBtn = document.getElementById('sessionBtn');
  var sessionMenu = document.getElementById('sessionMenu');
  var sessionItems = [];
  var panelBtn = document.getElementById('panelbtn');
  var queueEl = document.getElementById('queue');
  var menuToggle = document.getElementById('menuToggle');
  var menuEl = document.getElementById('menu');

  var currentBubble = null;
  var currentRaw = '';
  var busy = false;
  var timerId = null;
  var startedAt = 0;
  var chars = 0;
  /* ---- 内联过程段（v1.9.0）：思考与工具调用按发生顺序穿插在回复正文之间，
   * 默认折叠成一行标题，点标题展开详情。事件到达顺序就是真实顺序。 ---- */
  var segThoughtEl = null;      // 正在积累的思考块
  var segThoughtLabel = null;
  var segThoughtBody = null;
  var segThoughtRaw = '';
  var pendingTool = null;       // 正在执行的工具段 { el, head, glyph, label, body, title, argsRaw, startedAt }
  var hadError = false;

  /* Locally editable outbound queue. The host session stays one-at-a-time;
   * this queue lets the human keep typing while a reply is still streaming. */
  var queue = [];
  var queuePaused = false;
  var queueSeq = 0;
  /* 这一轮失败的类别（宿主随 error 事件带来）。超时属于环境问题：模型服务
   * 慢、GGUF 刚加载、内网抖动，和队列里下一条任务无关，所以接着发；
   * 认证失败 / 地址写错 / 用户 Stop 则继续发只会同样失败，照旧暂停。
   * 连续超时到上限才停，避免在已经死掉的服务上空转。 */
  var MAX_TIMEOUT_STREAK = 2;
  var timeoutStreak = 0;
  var lastErrorKind = '';

  /* 已导入的文件：显示在输入框正上方，× 可以撤销这一次导入。
   * 文件正文已经在对话历史里了，标签是它的可见凭据与撤回入口。 */
  var attachments = [];

  /* 会话：宿主保存每个会话的 history（模型上下文），屏幕内容在这里按会话存
   * innerHTML 快照，切回来直接还原。消息区里的节点都是静态展示，不需要重新绑事件。 */
  var snapshots = {};
  var activeSessionId = '';
  var keyPresent = true;

  var markdown = (typeof window !== 'undefined' && window.MarkdownLite) ? window.MarkdownLite : null;
  var lastCheck = null;

  /* Consecutive identical tool failures collapse into one line with a counter,
   * otherwise a looping model floods the chat with the same English error. */
  var lastToolEl = null;
  var lastToolBadge = null;
  var lastToolKey = '';
  var lastToolRepeat = 0;

  /* Raw host messages are English (they also go to the model). Show a short
   * Chinese reason instead, keep the raw text in the tooltip. */
  var TOOL_NOTICES = [
    [/^TOOL ERROR: File already exists/, '文件已存在，没有覆盖（要覆盖请加 overwrite:true；改写用 saveText）'],
    [/^TOOL ERROR: Refusing to access a path outside the workspace folder/, '拒绝访问工作区外的路径（只能用工作区内的相对路径）'],
    [/^TOOL ERROR: Binary file, not text/, '这是二进制文件，不能当文本读'],
    [/^TOOL ERROR: File too large/, '文件超过 200 KB 读取上限'],
    [/^TOOL ERROR: Target directory does not exist/, '目标目录不存在，没有写（改用 createFile）'],
    [/^TOOL ERROR: No active editor/, '当前没有打开的编辑器'],
    [/^TOOL ERROR: Text too long/, '内容超过写入长度上限'],
    [/^TOOL ERROR: Path not allowed/, '路径不在允许的范围内'],
    [/^TOOL BLOCKED BY CONSTRAINT/, '被硬约束拦下，没有执行'],
    [/^TOOL BLOCKED: this exact call/, '重复的失败调用已跳过'],
    [/^TOOL BLOCKED: user rejected/, '你拒绝了这次调用，没有执行'],
    [/^TOOL BLOCKED: tool approval timed out/, '工具审批超时，没有执行'],
    [/^TOOL BLOCKED/, '没有执行'],
    [/^TOOL ERROR:/, '工具执行失败']
  ];

  function toolNotice(text) {
    var raw = String(text || '');
    for (var i = 0; i < TOOL_NOTICES.length; i++) {
      if (TOOL_NOTICES[i][0].test(raw)) {
        var detail = raw.replace(/^TOOL (ERROR|BLOCKED)[^:]*:?/, '').trim();
        return { label: TOOL_NOTICES[i][1], detail: detail };
      }
    }
    return null;
  }

  function resetToolDedupe() {
    lastToolEl = null;
    lastToolBadge = null;
    lastToolKey = '';
    lastToolRepeat = 0;
  }

  function addToolIssue(text, status) {
    var notice = toolNotice(text);
    var key = status + '|' + text;
    if (lastToolEl && lastToolKey === key) {
      lastToolRepeat += 1;
      if (lastToolBadge) { lastToolBadge.textContent = '（重复 ' + lastToolRepeat + ' 次）'; }
      scrollDown();
      return;
    }
    var el = document.createElement('div');
    el.className = 'msg tool ' + (status === 'blocked' ? 'tool-block' : 'tool-fail');
    el.title = text;
    var head = document.createElement('span');
    head.className = 'tool-head';
    head.textContent = (status === 'blocked' ? '⊘ ' : '⚠ ') + (notice ? notice.label : '工具执行失败');
    el.appendChild(head);
    if (notice && notice.detail) {
      var detail = document.createElement('div');
      detail.className = 'tool-detail';
      detail.textContent = notice.detail.slice(0, 200);
      el.appendChild(detail);
    }
    lastToolBadge = document.createElement('span');
    lastToolBadge.className = 'tool-repeat';
    el.appendChild(lastToolBadge);
    messagesEl.appendChild(el);
    lastToolEl = el;
    lastToolKey = key;
    lastToolRepeat = 0;
    scrollDown();
  }

  function addToolLine(msg) {
    var status = msg.status || '';
    if (status === 'call') { addToolCallSeg(msg); return; }
    if (status === 'failed' || status === 'blocked') { finishToolIssue(msg); return; }
    if (status === 'ok') {
      finishToolSeg(msg);
      resetToolDedupe();
      return;
    }
    addMessage('tool', msg.text || '');
  }

  function renderRich(el, raw) {
    if (markdown && typeof markdown.render === 'function') {
      el.innerHTML = markdown.render(raw);
    } else {
      el.textContent = raw;
    }
  }

  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  /* 回合分割线：一次完整回答结束后，下一条用户消息之前插一条横线，
   * 让「上一轮到此结束、下面是新的一问」有明确的视觉停顿。只在已有内容、
   * 且上一条不是分割线时插入，重放历史时同样生效。 */
  function addTurnDivider() {
    if (!messagesEl.firstChild) { return; }
    var last = messagesEl.lastChild;
    if (last && last.classList && last.classList.contains('divider')) { return; }
    var el = document.createElement('div');
    el.className = 'msg divider';
    el.setAttribute('role', 'separator');
    messagesEl.appendChild(el);
  }

  /* badge：气泡左上角的小角标（目前用于「定时 02:00」）。文本放进子节点
   * 而不是直接 el.textContent，否则设置 textContent 会把角标一起清掉。 */
  function addMessage(role, text, badge) {
    if (role === 'user') { addTurnDivider(); }
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    if (role === 'assistant' || role === 'error') {
      renderRich(el, text);
    } else if (badge) {
      var chip = document.createElement('span');
      chip.className = 'msg-badge';
      chip.textContent = badge;
      el.appendChild(chip);
      var body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = text;
      el.appendChild(body);
    } else {
      el.textContent = text;
    }
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  /* 定时任务的角标只写文字。以前前面挂一个闹钟 emoji（U+23F0）：Win7 的
   * Segoe UI Symbol 里它是黑白轮廓，字体被精简过的机器上还会变成豆腐块。
   * 「定时」两个字本身就说明了一切，不必赌字体。 */
  function scheduleBadge(ts) { return '定时 ' + clockLabel(ts); }

  /* 顶端记忆容量条。percent = 会话历史字符数 / 上下文预算；满了以后更早的
   * 消息就不再送进模型（自动压缩会先收成一条摘要）。这里只做显示，容量上限
   * 由宿主按设置算好再发下来，前端不猜。 */
  function fmtChars(n) {
    n = Number(n) || 0;
    if (n < 10000) { return String(n); }
    var w = n / 10000;
    return (w >= 10 ? Math.round(w) : Math.round(w * 10) / 10) + ' 万';
  }

  function applyMemory(mem) {
    if (!memBar || !memFill || !memText || !mem || typeof mem !== 'object') { return; }
    var pct = Number(mem.percent);
    if (!isFinite(pct)) { pct = 0; }
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var used = Number(mem.used) || 0;
    var limit = Number(mem.limit) || 0;
    var msgs = Number(mem.messages) || 0;
    var dropped = Number(mem.dropped) || 0;
    var live = Number(mem.live) || 0;
    memFill.style.width = pct + '%';
    memBar.setAttribute('aria-valuenow', String(pct));
    var full = dropped > 0 || pct >= 100;
    var warn = !full && pct >= 80;
    memBar.className = 'membar' + (full ? ' full' : (warn ? ' warn' : ''));

    var label = '记忆 ' + pct + '%';
    if (msgs === 0 && !live) { label = '记忆 0%（新对话）'; }
    else if (full) { label = '记忆已满 ' + pct + '%'; }
    else {
      label += ' · ' + fmtChars(used) + ' / ' + fmtChars(limit);
      if (live) { label += ' · 生成中'; }
    }
    memText.textContent = label;
    /* 读屏只报百分比意义不大，把「用了多少 / 上限多少」一起给它。 */
    memBar.setAttribute('aria-valuetext', label);

    var title = '上下文记忆：' + used + ' / ' + limit + ' 字符（' + pct + '%），共 ' + msgs +
      ' 条消息；本轮会送入最近 ' + (Number(mem.includedMessages) || 0) + ' 条（' +
      (Number(mem.included) || 0) + ' 字符）。';
    if (live) {
      title += '其中 ' + live + ' 字符是本轮进行中的临时内容（工具结果 / 正在生成的回复），尚未写入历史。';
    }
    if (dropped > 0) {
      title += '更早的 ' + dropped + ' 条已不再参与——AI 会忘掉那部分内容。';
    }
    if (mem.summarized) {
      title += '较早的对话已被自动压缩成一条摘要（【历史摘要】），细节以实际文件为准。';
    }
    if (pct >= 80 && !full) { title += '接近上限，必要时可清空对话或新开一条。'; }
    title += '上限由设置 win7Agent.maxContextChars（' + limit + '）与 maxHistoryMessages（' +
      (Number(mem.messageLimit) || 0) + '）决定。';
    memBar.title = title;

  }

  /* 定时任务的时间戳在历史里是毫秒数，显示成 02:00 就够。 */
  function clockLabel(ts) {
    var d = new Date(Number(ts) || Date.now());
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* 撤回条目（v1.10）：本轮 Agent 真实写入了文件时，在回复下方给一行
   * 「↩ 撤回本轮改动」，点一下恢复原内容/删除新建文件。快照在宿主内存里
   * 只保留最近几轮，重启后点击会得到「快照已失效」提示。 */
  function addSnapshotRow(id, files) {
    if (!id || !files.length) { return; }
    var names = [];
    for (var i = 0; i < files.length && i < 6; i++) { names.push(String(files[i] || '')); }
    if (files.length > 6) { names.push('等 ' + files.length + ' 个文件'); }
    var el = document.createElement('div');
    el.className = 'msg snapshot';
    var btn = document.createElement('button');
    btn.className = 'snap-undo';
    btn.type = 'button';
    btn.setAttribute('data-id', id);
    btn.textContent = '↩ 撤回本轮改动（' + files.length + ' 个文件）';
    btn.title = '恢复这一轮写入前的文件内容；本轮新建的文件会被删除。\n' + names.join('\n');
    el.appendChild(btn);
    var label = document.createElement('span');
    label.className = 'snap-files';
    label.textContent = names.join('、');
    el.appendChild(label);
    messagesEl.appendChild(el);
    scrollDown();
  }

  /* Completion check card. The host sends a verdict built from this round's
   * real tool calls, so the user can tell "真的做了" from "只是说做了". */
  function addCheck(msg) {
    var lvl = msg.level === 'fail' ? 'fail' : (msg.level === 'warn' ? 'warn' : 'ok');
    var el = document.createElement('div');
    el.className = 'msg check chk-' + lvl;

    var head = document.createElement('div');
    head.className = 'check-head';
    var tag = document.createElement('span');
    tag.className = 'check-tag chk-tag-' + lvl;
    tag.textContent = lvl === 'ok' ? '[完成自检]' : (lvl === 'warn' ? '[自检提醒]' : '[自检未通过]');
    head.appendChild(tag);
    var title = document.createElement('span');
    title.className = 'check-title';
    title.textContent = msg.title || '';
    head.appendChild(title);
    el.appendChild(head);

    if (msg.text) {
      var body = document.createElement('div');
      body.className = 'check-text';
      body.textContent = msg.text;
      el.appendChild(body);
    }

    var lines = Array.isArray(msg.evidence) ? msg.evidence : [];
    if (lines.length) {
      var ul = document.createElement('div');
      ul.className = 'check-evidence';
      lines.forEach(function (line) {
        var li = document.createElement('div');
        li.className = 'check-line';
        li.textContent = line;
        ul.appendChild(li);
      });
      el.appendChild(ul);
    }

    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function setBusy(value) {
    busy = value;
    // Deliberately keep Send enabled while busy: new input goes to the queue.
    sendBtn.disabled = false;
    stopBtn.disabled = !value;
    /* 按钮始终写「Send」。忙碌时点它其实是排到这一轮之后，但把按钮改名成
     * 「排队」会让人以为功能变了、找不到发送键；用悬停提示说明就够了。 */
    sendBtn.textContent = 'Send';
    sendBtn.title = value
      ? '正在回复：点击会排到这一轮结束之后发送'
      : '发送（Ctrl+Enter）';
  }

  function fmt(sec) {
    if (sec < 60) { return sec.toFixed(1) + ' s'; }
    return Math.floor(sec / 60) + ' m ' + (sec % 60).toFixed(0) + ' s';
  }

  function renderTimer() {
    if (!timerId) { return; }
    var sec = (Date.now() - startedAt) / 1000;
    timerEl.textContent = '已用时 ' + fmt(sec) + (chars ? ' · ' + chars + ' 字' : '');
  }

  function startTimer(ts) {
    if (timerId) { clearInterval(timerId); }
    startedAt = ts || Date.now();
    chars = 0;
    timerId = setInterval(renderTimer, 200);
    progressEl.hidden = false;
    phaseDot.className = 'pdot active';
    timerEl.textContent = '';
    renderTimer();
  }

  function stopTimer(elapsedMs) {
    if (timerId) { clearInterval(timerId); timerId = null; }
    var ms = typeof elapsedMs === 'number' ? elapsedMs : (Date.now() - startedAt);
    timerEl.textContent = '用时 ' + fmt(ms / 1000);
    progressEl.hidden = true;
    phaseDot.className = 'pdot';
  }

  function resetSegs() {
    segThoughtEl = null;
    segThoughtLabel = null;
    segThoughtBody = null;
    segThoughtRaw = '';
    pendingTool = null;
  }

  /* 思考块遇到新事件（正文 / 工具调用）就收口：后面的思考属于下一轮。 */
  function closeThoughtSeg() {
    segThoughtEl = null;
    segThoughtLabel = null;
    segThoughtBody = null;
    segThoughtRaw = '';
  }

  function addThoughtSeg(text) {
    if (!segThoughtEl) {
      segThoughtEl = document.createElement('div');
      segThoughtEl.className = 'msg seg seg-thought';
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'seg-toggle';
      head.setAttribute('aria-expanded', 'false');
      head.title = '点开/收起思考过程';
      var glyph = document.createElement('span');
      glyph.className = 'seg-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = '▸';
      head.appendChild(glyph);
      segThoughtLabel = document.createElement('span');
      segThoughtLabel.className = 'seg-label';
      segThoughtLabel.textContent = '思考过程 (0 字)';
      head.appendChild(segThoughtLabel);
      segThoughtEl.appendChild(head);
      segThoughtBody = document.createElement('pre');
      segThoughtBody.className = 'seg-body';
      segThoughtBody.hidden = true;
      segThoughtEl.appendChild(segThoughtBody);
      segThoughtRaw = '';
      messagesEl.appendChild(segThoughtEl);
    }
    segThoughtRaw += String(text || '');
    segThoughtBody.textContent = segThoughtRaw;
    segThoughtLabel.textContent = '思考过程 (' + segThoughtRaw.length + ' 字)';
    scrollDown();
  }

  /* 工具调用段：一行标题（✎ 动作：对象 · 状态），展开看参数与结果。 */
  function toolArgsOf(text) {
    var m = /^tool -> (\S+)\s*([\s\S]*)$/.exec(String(text || ''));
    if (m) { return { name: m[1], argsRaw: m[2] }; }
    return { name: '', argsRaw: String(text || '') };
  }

  function shortOf(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function friendlyTool(name, argsRaw) {
    var args = {};
    try { args = JSON.parse(argsRaw) || {}; } catch (e) { /* 截断的 JSON 解不了，就走默认 */ }
    var p = String(args.path || args.dir || args.task || args.command || '');
    switch (name) {
      case 'readFile': return '查看文件' + (p ? '：' + shortOf(p, 60) : '');
      case 'importFile': return '导入文件' + (p ? '：' + shortOf(p, 60) : '');
      case 'listFiles': return '列出目录' + (p ? '：' + shortOf(p, 60) : '');
      case 'getActiveFile': return '读取当前打开的文件';
      case 'insertText': return '插入文本' + (p ? '：' + shortOf(p, 60) : '');
      case 'saveText': return '修改文件' + (p ? '：' + shortOf(p, 60) : '');
      case 'createFile': return '新建文件' + (p ? '：' + shortOf(p, 60) : '');
      case 'runCommand': return '运行命令' + (p ? '：' + shortOf(p, 70) : '');
      case 'runSubtask': return '子任务' + (p ? '：' + shortOf(p, 40) : '');
      default: return name ? '调用 ' + name : '调用工具';
    }
  }

  function fmtSegDur(ms) {
    var sec = ms / 1000;
    if (sec < 60) { return sec.toFixed(1) + ' s'; }
    return Math.floor(sec / 60) + ' m ' + Math.round(sec % 60) + ' s';
  }

  function addToolCallSeg(msg) {
    closeThoughtSeg();
    var parsed = toolArgsOf(msg.text);
    var title = friendlyTool(parsed.name, parsed.argsRaw);
    var el = document.createElement('div');
    el.className = 'msg seg seg-tool running';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'seg-toggle';
    head.setAttribute('aria-expanded', 'false');
    head.title = '点开查看调用参数与结果';
    var glyph = document.createElement('span');
    glyph.className = 'seg-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '▸';
    head.appendChild(glyph);
    var label = document.createElement('span');
    label.className = 'seg-label';
    label.textContent = '✎ ' + title + ' · 运行中…';
    head.appendChild(label);
    el.appendChild(head);
    var body = document.createElement('pre');
    body.className = 'seg-body';
    body.hidden = true;
    body.textContent = '参数：' + (parsed.argsRaw || '（无）');
    el.appendChild(body);
    messagesEl.appendChild(el);
    pendingTool = { el: el, head: head, label: label, body: body, title: title, argsRaw: parsed.argsRaw, startedAt: Date.now() };
    scrollDown();
  }

  function segBodyText(argsRaw, resultText) {
    return '参数：' + (argsRaw || '（无）') + (resultText ? '\n结果：' + resultText : '');
  }

  function finishToolSeg(msg) {
    if (!pendingTool) { return; }
    var p = pendingTool;
    pendingTool = null;
    p.label.textContent = '✎ ' + p.title + ' · ' + fmtSegDur(Date.now() - p.startedAt);
    p.el.className = 'msg seg seg-tool done';
    p.body.textContent = segBodyText(p.argsRaw, msg.text);
  }

  /* 失败 / 被拦截：把「运行中」那行就地变成红色问题行，并接上原有的重复折叠计数。 */
  function finishToolIssue(msg) {
    var notice = toolNotice(msg.text);
    var key = (msg.status || '') + '|' + (msg.text || '');
    var verdict = msg.status === 'blocked' ? '已拦截' : '失败';
    /* 和上一次失败一模一样：折叠进上一行，只加重复计数，不刷屏。
     * 这轮新开的「运行中」行也一并移除。 */
    if (lastToolEl && lastToolKey === key) {
      if (pendingTool && pendingTool.el.parentNode) {
        pendingTool.el.parentNode.removeChild(pendingTool.el);
      }
      pendingTool = null;
      lastToolRepeat += 1;
      if (lastToolBadge) { lastToolBadge.textContent = '（重复 ' + lastToolRepeat + ' 次）'; }
      scrollDown();
      return;
    }
    if (pendingTool) {
      var p = pendingTool;
      pendingTool = null;
      /* 失败原因直接写在标题行上，不用展开就能看到为什么没执行 */
      p.label.textContent = '✎ ' + p.title + ' · ' + verdict + '：' + (notice ? notice.label : '工具执行失败');
      p.el.className = 'msg seg seg-tool ' + (msg.status === 'blocked' ? 'tool-block' : 'tool-fail');
      p.el.title = msg.text || '';
      p.body.textContent = segBodyText(p.argsRaw, (notice && notice.detail ? notice.detail + '\n' : '') + (msg.text || ''));
      lastToolEl = p.el;
      lastToolKey = key;
      lastToolRepeat = 0;
      lastToolBadge = document.createElement('span');
      lastToolBadge.className = 'tool-repeat';
      p.head.appendChild(lastToolBadge);
      scrollDown();
      return;
    }
    addToolIssue(msg.text || '', msg.status);
  }

  /* 一轮结束时如果工具结果没等到（出错 / 用户停止），别把「运行中…」留在屏上。 */
  function abandonPendingTool(word) {
    if (!pendingTool) { return; }
    var p = pendingTool;
    pendingTool = null;
    p.label.textContent = '✎ ' + p.title + ' · ' + (word || '已中断');
    p.el.className = 'msg seg seg-tool failed';
    scrollDown();
  }

  function qbtn(label, handler, title) {
    var b = document.createElement('button');
    b.className = 'qbtn';
    b.type = 'button';
    b.textContent = label;
    /* 图标按钮（✎ ✕ ↑ ↓）没有文字，悬停提示与无障碍名必须补上语义。 */
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    if (handler) { b.addEventListener('click', handler); }
    return b;
  }

  /* 附件标签只显示文件名：完整路径放在悬停提示里。长路径会把 chip 挤到
   * 省略号，反而看不到到底是哪个文件，所以正文用 basename。 */
  function baseName(p) {
    var s = String(p == null ? '' : p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (i >= 0 && i < s.length - 1) ? s.slice(i + 1) : s;
  }

  function attachMeta(item) {
    var bits = [];
    if (item.kind) { bits.push(item.kind); }
    if (item.chars) { bits.push(item.chars + ' 字符'); }
    if (item.truncated) { bits.push('已截断'); }
    return bits.join(' · ');
  }

  /* ---- 会话列表与屏幕切换 ---- */

  /* 相对时间：列表里只需要"多久以前"，精确到分钟就够，省宽度。 */
  function relTime(ts) {
    var t = Number(ts) || 0;
    if (!t) { return ''; }
    var diff = Date.now() - t;
    if (diff < 60000) { return '刚刚'; }
    if (diff < 3600000) { return Math.floor(diff / 60000) + ' 分钟前'; }
    if (diff < 86400000) { return Math.floor(diff / 3600000) + ' 小时前'; }
    if (diff < 172800000) { return '昨天'; }
    return Math.floor(diff / 86400000) + ' 天前';
  }

  function openSessionMenu() {
    if (!sessionMenu || !sessionBtn) { return; }
    sessionMenu.hidden = false;
    sessionBtn.classList.add('open');
    sessionBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSessionMenu() {
    if (!sessionMenu || !sessionBtn) { return; }
    sessionMenu.hidden = true;
    sessionBtn.classList.remove('open');
    sessionBtn.setAttribute('aria-expanded', 'false');
  }

  function renderSessionList(items, activeId) {
    sessionItems = items || [];
    /* 对话被删掉后，它对应的屏幕快照也别留着了。 */
    var alive = {};
    sessionItems.forEach(function (s) { alive[s.id] = 1; });
    Object.keys(snapshots).forEach(function (k) {
      if (!alive[k] && k !== activeSessionId) { delete snapshots[k]; }
    });
    if (sessionBtn) {
      sessionBtn.title = '切换 / 新建 / 删除对话（共 ' + sessionItems.length + ' 个）';
    }
    if (!sessionMenu) { return; }
    sessionMenu.textContent = '';

    /* 新建放在列表最上面：+ 不再是 composer 里的独立按钮，省一行宽度。 */
    var addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'sess-item sess-new';
    addRow.title = '开一个空对话；当前对话保留在列表里';
    var addMark = document.createElement('span');
    addMark.className = 's-mark';
    addMark.setAttribute('aria-hidden', 'true');
    addMark.textContent = '＋';
    var addTitle = document.createElement('span');
    addTitle.className = 's-title';
    addTitle.textContent = '新对话';
    addRow.appendChild(addMark);
    addRow.appendChild(addTitle);
    addRow.addEventListener('click', function () {
      closeSessionMenu();
      vscode.postMessage({ type: 'newSession' });
    });
    sessionMenu.appendChild(addRow);

    var sep = document.createElement('div');
    sep.className = 'sess-sep';
    sessionMenu.appendChild(sep);

    sessionItems.forEach(function (s) {
      var isActive = s.id === activeId;
      var row = document.createElement('div');
      row.className = isActive ? 'sess-row active' : 'sess-row';

      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'sess-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
      item.title = (s.title || '新对话') + '（' + (s.count || 0) + ' 条消息' +
        (s.updatedAt ? ' · ' + relTime(s.updatedAt) : '') + '）';

      var mark = document.createElement('span');
      mark.className = 's-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = isActive ? '✓' : '';

      var title = document.createElement('span');
      title.className = 's-title';
      title.textContent = s.title || '新对话';

      var meta = document.createElement('span');
      meta.className = 's-meta';
      meta.textContent = relTime(s.updatedAt);

      item.appendChild(mark);
      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener('click', function () {
        closeSessionMenu();
        vscode.postMessage({ type: 'switchSession', id: s.id });
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'sess-del';
      del.title = '删除这个对话（不可恢复）';
      del.setAttribute('aria-label', '删除对话：' + (s.title || '新对话'));
      del.textContent = '×';
      del.addEventListener('click', function (e) {
        e.stopPropagation();   // 别触发切换
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });

      row.appendChild(item);
      row.appendChild(del);
      sessionMenu.appendChild(row);
    });
  }

  function switchScreen(id, count, silent) {
    var prev = activeSessionId;
    activeSessionId = id || '';
    if (prev === activeSessionId) { return; }
    if (prev) { snapshots[prev] = messagesEl.innerHTML || ''; }
    var snap = snapshots[activeSessionId];
    messagesEl.textContent = '';
    if (snap) {
      messagesEl.innerHTML = snap;
    } else if (count > 0 && !silent) {
      // 重启后只剩模型上下文，屏幕内容没有快照：说清楚，别让人以为历史丢了。
      addMessage('notice', '已切到这个对话：' + count + ' 条上下文仍在（旧消息不重绘）。');
    }
    currentBubble = null;
    currentRaw = '';
    hadError = false;
    lastCheck = null;
    resetToolDedupe();
    resetSegs();
    attachments = [];
    renderAttachments();
    queue = [];
    queuePaused = false;
    timeoutStreak = 0;
    lastErrorKind = '';
    renderQueue();
  }

  function renderAttachments() {
    if (!attachEl) { return; }
    attachEl.hidden = attachments.length === 0;
    attachEl.textContent = '';
    if (!attachments.length) { return; }

    var head = document.createElement('span');
    head.className = 'attach-head';
    head.textContent = '已导入 (' + attachments.length + ')';
    attachEl.appendChild(head);

    attachments.forEach(function (item) {
      var meta = attachMeta(item);
      var chip = document.createElement('span');
      chip.className = 'achip';
      chip.title = item.name + (meta ? ' · ' + meta : '') + '｜点 × 移除';

      var name = document.createElement('span');
      name.className = 'achip-name';
      name.textContent = baseName(item.name);
      chip.appendChild(name);

      if (meta) {
        var metaEl = document.createElement('span');
        metaEl.className = 'achip-meta';
        metaEl.textContent = meta;
        chip.appendChild(metaEl);
      }

      var x = document.createElement('button');
      x.className = 'achip-x';
      x.type = 'button';
      x.textContent = '×';
      x.title = '移除这份文件（下一轮起模型不再看到它）';
      x.addEventListener('click', function () {
        vscode.postMessage({ type: 'removeAttachment', id: item.id });
      });
      chip.appendChild(x);

      attachEl.appendChild(chip);
    });
  }

  /* Ids make the render idempotent: a reopened view can receive the full list
   * and a single item for the same import without showing it twice. */
  function upsertAttachment(item) {
    if (!item || !item.id) { return; }
    var i = -1;
    for (var k = 0; k < attachments.length; k++) {
      if (attachments[k].id === item.id) { i = k; break; }
    }
    if (i >= 0) { attachments[i] = item; } else { attachments.push(item); }
    renderAttachments();
  }

  function renderQueue() {
    if (!queueEl) { return; }
    queueEl.hidden = queue.length === 0;
    queueEl.textContent = '';
    if (!queue.length) { return; }

    var head = document.createElement('div');
    head.className = 'queue-head';
    var title = document.createElement('span');
    title.textContent = '待发送 (' + queue.length + ')' + (queuePaused ? ' · 已暂停' : '');
    head.appendChild(title);
    var resume = qbtn('继续队列', function () {
      queuePaused = false;
      /* 手动继续 = 重新开始计数，否则上一轮的超时会让它立刻又被暂停。 */
      timeoutStreak = 0;
      renderQueue();
      pumpQueue();
    });
    resume.hidden = !queuePaused;
    head.appendChild(resume);
    var clearAll = qbtn('全部撤回', function () {
      queue = [];
      queuePaused = false;
      renderQueue();
      phaseText.textContent = '已清空暂存队列';
      phaseText.className = 'ptext';
    });
    head.appendChild(clearAll);
    queueEl.appendChild(head);

    queue.forEach(function (item, i) {
      var row = document.createElement('div');
      row.className = 'qitem';
      if (item.editing) {
        var ta = document.createElement('textarea');
        ta.className = 'qedit';
        ta.rows = 2;
        ta.value = item.text;
        row.appendChild(ta);
        var editBar = document.createElement('div');
        editBar.className = 'qactions';
        editBar.appendChild(qbtn('保存', function () {
          var v = ta.value.trim();
          if (!v) { queue.splice(i, 1); }
          else { item.text = v; item.editing = false; }
          renderQueue();
          ta.focus();
        }));
        editBar.appendChild(qbtn('取消', function () {
          item.editing = false;
          renderQueue();
        }));
        row.appendChild(editBar);
        setTimeout(function () { ta.focus(); }, 0);
      } else {
        var body = document.createElement('div');
        body.className = 'qtext';
        body.textContent = (i + 1) + '. ' + item.text;
        row.appendChild(body);
        var acts = document.createElement('div');
        acts.className = 'qactions';
        var editBtn = qbtn('✎', function () { item.editing = true; renderQueue(); }, '编辑');
        editBtn.className = 'qbtn ic';
        acts.appendChild(editBtn);
        var up = qbtn('↑', function () {
          if (i > 0) { queue.splice(i - 1, 0, queue.splice(i, 1)[0]); renderQueue(); }
        });
        up.disabled = i === 0;
        acts.appendChild(up);
        var down = qbtn('↓', function () {
          if (i < queue.length - 1) { queue.splice(i + 1, 0, queue.splice(i, 1)[0]); renderQueue(); }
        });
        down.disabled = i === queue.length - 1;
        acts.appendChild(down);
        var rmBtn = qbtn('✕', function () { queue.splice(i, 1); renderQueue(); }, '撤回');
        rmBtn.className = 'qbtn ic';
        acts.appendChild(rmBtn);
        row.appendChild(acts);
      }
      queueEl.appendChild(row);
    });
  }

  function enqueue(text) {
    queue.push({ id: ++queueSeq, text: text, editing: false });
    renderQueue();
    phaseText.textContent = '已暂存 ' + queue.length + ' 条，当前回复完成后按顺序发送';
    phaseText.className = 'ptext';
  }

  function pumpQueue() {
    if (busy || queuePaused || !queue.length) { return; }
    var next = queue.shift();
    renderQueue();
    dispatch(next.text);
  }

  function dispatch(text) {
    addMessage('user', text);
    currentBubble = null;
    currentRaw = '';
    hadError = false;
    lastErrorKind = '';
    lastCheck = null;
    resetToolDedupe();
    phaseText.textContent = '正在准备请求…';
    phaseText.className = 'ptext';
    phaseDot.className = 'pdot';
    vscode.postMessage({ type: 'send', text: text });
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text) { return; }
    inputEl.value = '';
    if (busy) { enqueue(text); return; }
    dispatch(text);
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', function () {
    phaseText.textContent = '正在取消…';
    phaseText.className = 'ptext';
    vscode.postMessage({ type: 'stop' });
  });
  clearBtn.addEventListener('click', function () { vscode.postMessage({ type: 'clear' }); });
  keyBtn.addEventListener('click', function () { vscode.postMessage({ type: 'setKey' }); });
  importBtn.addEventListener('click', function () { vscode.postMessage({ type: 'import' }); });
  exportBtn.addEventListener('click', function () { vscode.postMessage({ type: 'export' }); });
  settingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'settings' }); });
  endpointBtn.addEventListener('click', function () { vscode.postMessage({ type: 'endpoint' }); });
  keyState.addEventListener('click', function () {
    // 没配 key 时这个徽标就是唯一显眼的入口：直接弹设置框，而不是先诊断再让人去菜单找。
    vscode.postMessage({ type: keyPresent ? 'diagnose' : 'setKey' });
  });
  authorBtn.addEventListener('click', function () { vscode.postMessage({ type: 'about' }); });
  rulesBtn.addEventListener('click', function () { vscode.postMessage({ type: 'rules' }); });
  if (lessonsBtn) {
    lessonsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'lessons' }); });
  }
  if (profilesBtn) {
    profilesBtn.addEventListener('click', function () { vscode.postMessage({ type: 'profiles' }); });
  }
  if (schedBtn) {
    /* 定时发送：内容是输入框里现成的那段文字，时间由宿主弹选择器。
     * 输入框空着就直接提示，不要弹一个「定时什么」的空白窗口。 */
    schedBtn.addEventListener('click', function () {
      var text = inputEl.value.trim();
      if (!text) {
        phaseText.textContent = '先在输入框写好要定时执行的任务';
        phaseText.className = 'ptext awaiting';
        inputEl.focus();
        return;
      }
      vscode.postMessage({ type: 'scheduleDraft', text: text });
    });
  }
  if (flagWrite) {
    flagWrite.addEventListener('click', function () { vscode.postMessage({ type: 'writeMode' }); });
  }
  if (flagWriteConfirm) {
    flagWriteConfirm.addEventListener('click', function () { vscode.postMessage({ type: 'writeConfirm' }); });
  }
  if (flagShellConfirm) {
    flagShellConfirm.addEventListener('click', function () { vscode.postMessage({ type: 'shellConfirm' }); });
  }
  if (flagSubtask) {
    flagSubtask.addEventListener('click', function () { vscode.postMessage({ type: 'subtaskMode' }); });
  }
  if (sessionBtn && sessionMenu) {
    sessionBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (sessionMenu.hidden) { openSessionMenu(); } else { closeSessionMenu(); }
    });
    // 点面板任何其他位置、或按 Esc 都收起；点条目由条目自己处理（切换后收起）。
    document.addEventListener('click', function () { closeSessionMenu(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sessionMenu.hidden) {
        closeSessionMenu();
        sessionBtn.focus();
      }
    });
  }
  if (panelBtn) {
    panelBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openPanel' }); });
  }

  // Dropdown menu: toggle on the kebab button, close on outside click / Escape,
  // and auto-close after any menu item is chosen.
  function setMenu(open) {
    if (!menuEl || !menuToggle) { return; }
    menuEl.hidden = !open;
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuToggle.classList.toggle('open', open);
  }
  if (menuToggle && menuEl) {
    menuToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setMenu(menuEl.hidden);
    });
    menuEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.target.closest('button')) { setMenu(false); }
    });
    document.addEventListener('click', function () { setMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { setMenu(false); }
    });
  }

  /* 过程段的展开/收起用事件委托绑在消息区上：会话切换是 innerHTML 快照还原，
   * 直接绑在块上的监听器会被还原冲掉，委托不会。 */
  messagesEl.addEventListener('click', function (e) {
    /* 撤回本轮改动按钮（v1.10）：消息区节点在会话切换时会被 innerHTML 快照
     * 整体替换，所以用事件委托，data-id 恢复后依然有效。 */
    var undo = e.target && e.target.closest ? e.target.closest('.snap-undo') : null;
    if (undo && undo.getAttribute('data-id')) {
      vscode.postMessage({ type: 'revertSnapshot', id: undo.getAttribute('data-id') });
      undo.disabled = true;
      undo.textContent = '已请求撤回…';
      return;
    }
    var t = e.target && e.target.closest ? e.target.closest('.seg-toggle') : null;
    if (!t) { return; }
    var seg = t.parentNode;
    var body = seg.querySelector ? seg.querySelector('.seg-body') : null;
    if (!body) {
      // 兜底：直接在子节点里找（也兼容极端环境没有 querySelector 的情况）
      for (var i = 0; i < seg.children.length; i++) {
        if (seg.children[i].className.indexOf('seg-body') !== -1) { body = seg.children[i]; break; }
      }
    }
    if (!body) { return; }
    var open = body.hidden;
    body.hidden = !open;
    var glyph = t.querySelector('.seg-glyph');
    if (glyph) { glyph.textContent = open ? '▾' : '▸'; }
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---- @ 文件引用弹出 ----
   * 输入框里打出 @（词首）即弹出工作区文件的模糊匹配列表；
   * 上下键选择、Enter/Tab 确认、Esc 关闭，点击条目同样可选。
   * 选中后以 "@相对路径" 插入，随消息原样发给模型。 */
  var mentionFiles = [];
  var mentionItems = [];
  var mentionSel = 0;
  var currentMention = null;
  var mentionEl = null;
  var mentionReady = false;   // 宿主是否回过文件清单
  var mentionError = '';      // 宿主读取失败时的原因
  var mentionTruncated = false; // 文件太多，只索引了一部分
  var mentionTotal = 0;       // 索引到的文件数（用于提示）
  var mentionAskedAt = 0;     // 上次请求时间，避免每次按键都重发

  function ensureMentionEl() {
    if (mentionEl) { return mentionEl; }
    mentionEl = document.createElement('div');
    mentionEl.id = 'mention';
    mentionEl.hidden = true;
    inputEl.parentNode.appendChild(mentionEl);
    return mentionEl;
  }

  function closeMention() {
    if (mentionEl) { mentionEl.hidden = true; }
    mentionItems = [];
  }

  /* @ 的触发边界：开头、空白、标点、任意中文之后都算（中文输入习惯里 @ 前
   * 常常不敲空格）；只要 @ 前面不是字母/数字/下划线/点/斜杠（避免把
   * name@example.com 这类邮箱当成引用），就触发。全角 ＠ 与半角 @ 都认。 */
  function mentionQueryFromInput() {
    var pos = inputEl.selectionStart;
    if (pos === null || pos === undefined) { return null; }
    var before = inputEl.value.slice(0, pos);
    var re = /(^|[^A-Za-z0-9_.\-/@＠])[@＠]([^\s@＠]*)$/;
    var m = before.match(re);
    if (!m) { return null; }
    return { start: pos - m[2].length - 1, query: m[2] };
  }

  function fuzzyScore(path, q) {
    if (!q) { return 1; }
    var p = path.toLowerCase();
    var qi = q.toLowerCase();
    var idx = p.indexOf(qi);
    if (idx === 0) { return 100 - p.length / 1000; }
    if (idx > 0) { return 60 - idx - p.length / 1000; }
    var pi = 0;
    for (var k = 0; k < qi.length; k++) {
      pi = p.indexOf(qi.charAt(k), pi);
      if (pi === -1) { return -1; }
      pi++;
    }
    return 20 - qi.length;
  }

  function mentionHintText() {
    if (!mentionReady) { return '正在读取工作区文件…'; }
    if (mentionError) { return '文件清单读取失败：' + mentionError; }
    if (!mentionFiles.length) { return '工作区里没有可引用的文件（先打开一个文件夹）'; }
    if (mentionTruncated) {
      return '没有匹配的文件（已索引前 ' + mentionTotal + ' 个，可用更具体的片段再试）';
    }
    return '没有匹配的文件（共 ' + mentionTotal + ' 个可引用文件）';
  }

  /* 清单是宿主自己遍历出来的，卡住/为空时给一个显式重试入口——
   * force 会跳过宿主那 60 秒缓存。 */
  function requestMentionFiles(force) {
    mentionAskedAt = Date.now();
    vscode.postMessage({ type: 'mentionQuery', force: !!force });
  }

  function renderMention() {
    ensureMentionEl();
    var q = currentMention ? currentMention.query : '';
    var scored = [];
    for (var i = 0; i < mentionFiles.length && scored.length < 200; i++) {
      var s = fuzzyScore(mentionFiles[i], q);
      if (s > 0) { scored.push({ path: mentionFiles[i], score: s }); }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    mentionItems = scored.slice(0, 8).map(function (x) { return x.path; });
    if (mentionSel >= mentionItems.length) { mentionSel = Math.max(mentionItems.length - 1, 0); }
    // 没有候选也要给出可见反馈：首个 @ 时列出「正在读取」，读不到/无匹配
    // 时说明原因，否则用户会以为 @ 功能坏了。
    mentionEl.hidden = false;
    while (mentionEl.firstChild) { mentionEl.removeChild(mentionEl.firstChild); }
    if (!mentionItems.length) {
      var hint = document.createElement('div');
      hint.className = 'mention-empty';
      hint.textContent = mentionHintText();
      mentionEl.appendChild(hint);
      var retry = document.createElement('div');
      retry.className = 'mention-retry';
      retry.textContent = mentionReady ? '重新读取工作区文件' : '取消';
      retry.addEventListener('mousedown', function (e) {
        e.preventDefault();
        if (!mentionReady) { closeMention(); return; }
        mentionReady = false;
        mentionError = '';
        requestMentionFiles(true);
        renderMention();
      });
      mentionEl.appendChild(retry);
      return;
    }
    mentionItems.forEach(function (p, idx) {
      var it = document.createElement('div');
      it.className = 'mention-item' + (idx === mentionSel ? ' sel' : '');
      it.textContent = p;
      it.addEventListener('mousedown', function (e) { e.preventDefault(); applyMention(idx); });
      mentionEl.appendChild(it);
    });
    if (mentionTruncated) {
      var foot = document.createElement('div');
      foot.className = 'mention-empty';
      foot.textContent = '已索引前 ' + mentionTotal + ' 个文件（跳过 node_modules/.git）';
      mentionEl.appendChild(foot);
    }
  }

  function applyMention(idx) {
    if (!currentMention || !mentionItems[idx]) { closeMention(); currentMention = null; return; }
    var path = mentionItems[idx];
    var v = inputEl.value;
    var caret = inputEl.selectionStart;
    var before = v.slice(0, currentMention.start) + '@' + path + ' ';
    var after = v.slice(caret);
    inputEl.value = before + after;
    var next = before.length;
    inputEl.setSelectionRange(next, next);
    inputEl.focus();
    currentMention = null;
    closeMention();
  }

  function handleMentionInput() {
    var q = mentionQueryFromInput();
    currentMention = q;
    if (!q) { closeMention(); return; }
    if (q.query === '') { mentionSel = 0; }
    ensureMentionEl();
    // 文件清单按需请求：第一次、上次失败（5 秒后重试）、或超过 60 秒
    // （期间可能新建了文件）
    var quickRetry = !!mentionError || !mentionFiles.length;
    /* 已就绪：清单为空/失败 5 秒后可再问，否则 60 秒（期间可能新建了文件）。
     * 未就绪：1.5 秒内不重复发，避免连续按键把宿主问爆。 */
    var due = mentionReady
      ? (Date.now() - mentionAskedAt > (quickRetry ? 5000 : 60000))
      : (Date.now() - mentionAskedAt > 1500);
    if (due) { requestMentionFiles(false); }
    renderMention();
  }

  inputEl.addEventListener('input', handleMentionInput);
  // 中文输入法下 @ 的半角/全角转换不一定触发 input，compositionend 和
  // keydown 各补一次，避免「打了 @ 却没有任何反应」。
  inputEl.addEventListener('compositionend', function () {
    setTimeout(handleMentionInput, 0);
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === '@' || e.key === '＠') {
      setTimeout(handleMentionInput, 0);
    }
    if (mentionEl && !mentionEl.hidden && mentionItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSel = Math.min(mentionSel + 1, mentionItems.length - 1);
        renderMention();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSel = Math.max(mentionSel - 1, 0);
        renderMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mentionSel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        currentMention = null;
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('blur', function () {
    setTimeout(function () { closeMention(); }, 200);
  });

  /* 在光标处插入文本（粘贴与拖拽共用）。 */
  function insertTextAtCaret(text) {
    var v = inputEl.value;
    var start = (inputEl.selectionStart === null || inputEl.selectionStart === undefined) ? v.length : inputEl.selectionStart;
    var end = (inputEl.selectionEnd === null || inputEl.selectionEnd === undefined) ? v.length : inputEl.selectionEnd;
    inputEl.value = v.slice(0, start) + text + v.slice(end);
    var pos = start + text.length;
    try { inputEl.setSelectionRange(pos, pos); } catch (err) { /* 只读态忽略 */ }
    inputEl.focus();
    setTimeout(handleMentionInput, 0);
  }

  /* 粘贴兜底：VS Code webview 里 Ctrl+V 偶发异常——事件到了但默认插入失效，
   * 或事件被宿主工作台整个吞掉。两层接住且不会重复插入：
   * ① paste 事件到达时一律 preventDefault 并手动在光标处插入纯文本；
   * ② Ctrl+V 后 50ms 内没见到 paste 事件（被宿主吞掉），主动读系统剪贴板
   *    插入；读不到（无权限）就放弃，与旧行为一致，不会有副作用。 */
  var pasteSeenAt = 0;
  inputEl.addEventListener('paste', function (e) {
    pasteSeenAt = Date.now();
    var text = '';
    try { text = (e.clipboardData || window.clipboardData).getData('text/plain') || ''; } catch (err) { /* 留空 */ }
    if (e.preventDefault) { e.preventDefault(); }
    if (text) { insertTextAtCaret(text); }
  });
  inputEl.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'v') {
      setTimeout(function () {
        if (Date.now() - pasteSeenAt < 200) { return; }
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (t) {
            if (t && Date.now() - pasteSeenAt >= 200) { insertTextAtCaret(t); }
          }).catch(function () { /* 无权限，保持原状 */ });
        }
      }, 50);
    }
  });

  /* 拖文件到聊天区 → 自动变成 @相对路径 引用。webview 是 iframe：文件拖入
   * 若不 preventDefault 会被浏览器当导航处理（整个面板被文件替换掉），
   * 所以 document 级别一律拦截；文件名/绝对路径交给宿主解析成工作区相对
   * 路径（工作区外的文件按文件名在工作区内模糊匹配）。 */
  var dragDepth = 0;
  document.addEventListener('dragover', function (e) {
    if (e.preventDefault) { e.preventDefault(); }
  });
  document.addEventListener('dragenter', function (e) {
    if (e.preventDefault) { e.preventDefault(); }
    dragDepth += 1;
    inputEl.classList.add('dragging');
  });
  document.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { inputEl.classList.remove('dragging'); }
  });
  document.addEventListener('drop', function (e) {
    if (e.preventDefault) { e.preventDefault(); }
    dragDepth = 0;
    inputEl.classList.remove('dragging');
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    if (!files.length) { return; }
    var list = [];
    for (var i = 0; i < files.length; i++) {
      list.push({ name: files[i].name || '', path: (files[i].path || '') });
    }
    vscode.postMessage({ type: 'dropFiles', files: list });
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) { return; }
    switch (msg.type) {
      case 'state':
        applyMemory(msg.memory);
        /* 徽章直接显示当前在用的模型名：比 "key ok" 有用——一眼知道这次
         * 请求会打到哪个模型。没配 Key 才退回提示文字。 */
        var modelName = String(msg.model || '').trim();
        if (msg.hasKey || msg.localEndpoint) {
          keyState.textContent = modelName || '未指定模型';
          keyState.className = 'badge ok';
        } else {
          keyState.textContent = '未配置 Key';
          keyState.className = 'badge warn';
        }
        keyPresent = Boolean(msg.hasKey || msg.localEndpoint);
        keyState.title = keyPresent
          ? (modelName ? modelName + ' · ' : '') + msg.baseUrl + '（点击诊断连接）'
          : '还没有配置 API Key（点击设置；本地端点可留空）';
        /* 用户改了一处设置、另一处 scope 还压着它时，光显示生效值会让人以为
         * 「改了没用」。把谁在生效、谁没生效写进悬停提示。 */
        if (msg.modelNote) { keyState.title += '｜' + msg.modelNote; }
        if (msg.author) {
          authorBtn.textContent = '© ' + msg.author + ' · MIT · v' + msg.version;
          authorBtn.title = '© 2026 ' + msg.author + ' · MIT License · 反馈：' + (msg.email || '') + ' · ' + msg.appName + ' · ' + msg.target;
        }
        rulesBtn.textContent = '长期要求 (' + (msg.ruleCount || 0) + ')';
        if (lessonsBtn) {
          lessonsBtn.textContent = '经验记忆 (' + (msg.lessonCount || 0) + ')';
          lessonsBtn.title = '工具报错后被修好时自动总结的经验 ' + (msg.lessonCount || 0) +
            ' 条（' + (msg.autoLearn ? '自动学习已开启' : '自动学习已关闭') + '；点开可查看或删除）';
        }
        rulesBtn.title = '长期通用要求 ' + (msg.ruleCount || 0) + ' 条（其中记忆 ' +
          (msg.memoryCount || 0) + ' 条）｜Shell ' + (msg.allowShell ? '开' : '关') +
          '｜超时 ' + msg.timeoutSec + ' s';
        /* 配色语义：warn（黄）= 已经开始不问就做，属于要留意的状态；
         * on（蓝）= 某项能力开着；其余中性灰。所以「确认：关」才是黄的。 */
        if (flagWrite) {
          flagWrite.textContent = msg.writeMode ? '写入：可写' : '写入：只读';
          flagWrite.className = 'flag';
          flagWrite.setAttribute('aria-pressed', msg.writeMode ? 'true' : 'false');
          flagWrite.title = msg.writeMode
            ? '写入模式：可写（Agent 能改文件，点击改回只读）'
            : '写入模式：只读（Agent 不能改文件，点击允许写入）';
        }
        if (flagWriteConfirm) {
          flagWriteConfirm.textContent = msg.writeConfirm ? '写入确认：开' : '写入确认：关';
          flagWriteConfirm.className = 'flag';
          flagWriteConfirm.setAttribute('aria-pressed', msg.writeConfirm ? 'true' : 'false');
          flagWriteConfirm.title = msg.writeConfirm
            ? '写入确认：开（每次写文件前先问你，点击关闭）'
            : '写入确认：关——写文件不再问你，直接生效（点一下重新打开）';
        }
        if (flagShellConfirm) {
          flagShellConfirm.textContent = msg.shellConfirm ? '命令确认：开' : '命令确认：关';
          flagShellConfirm.className = 'flag';
          flagShellConfirm.setAttribute('aria-pressed', msg.shellConfirm ? 'true' : 'false');
          flagShellConfirm.title = msg.shellConfirm
            ? '命令确认：开（每条命令执行前先问你，点击关闭）'
            : '命令确认：关——PowerShell/CMD 直接运行，不再问你（点一下重新打开）';
        }
        if (flagSubtask) {
          flagSubtask.textContent = msg.subtaskMode ? '子任务：开' : '子任务：关';
          flagSubtask.className = 'flag';
          flagSubtask.setAttribute('aria-pressed', msg.subtaskMode ? 'true' : 'false');
          flagSubtask.title = msg.subtaskMode
            ? '子任务模式：开（独立子任务可交给子代理，点击关闭）'
            : '子任务模式：关（点击开启）';
        }
        if (msg.sessions) {
          switchScreen(msg.activeId, 0, true);
          renderSessionList(msg.sessions, msg.activeId);
        }
        rulesBtn.title = '长期通用要求 ' + (msg.ruleCount || 0) + ' 条（其中记忆 ' +
          (msg.memoryCount || 0) + ' 条）｜Shell ' + (msg.allowShell ? '开' : '关') +
          '｜超时 ' + msg.timeoutSec + ' s｜工具轮数 ' + msg.maxToolRounds +
          '｜历史 ' + msg.maxHistoryMessages + ' 条';
        if (profilesBtn) {
          profilesBtn.textContent = '模型配置 (' + (msg.profileCount || 0) + ')';
          profilesBtn.title = '多套「服务地址 + 模型 + key」一键切换' +
            (msg.profileName ? '｜当前：' + msg.profileName : '｜当前为自定义配置（未匹配任何已存配置）');
        }
        break;
      case 'prefill':
        inputEl.value = msg.text || '';
        inputEl.focus();
        break;
      case 'memory':
        applyMemory(msg.memory);
        break;
      case 'busy':
        if (msg.value) {
          setBusy(true);
          currentBubble = null;
          resetSegs();
          startTimer(msg.startedAt);
        } else {
          setBusy(false);
          stopTimer(msg.elapsedMs);
        }
        break;
      case 'phase':
        phaseText.textContent = msg.text || '';
        phaseText.className = 'ptext';
        phaseDot.className = busy ? 'pdot active' : 'pdot';
        break;
      case 'awaiting':
        // The agent is paused on a confirmation dialog. Highlight it in yellow
        // so the user knows a decision is required before it continues.
        phaseText.textContent = msg.text || '等待你的确认…';
        phaseText.className = 'ptext awaiting';
        phaseDot.className = 'pdot awaiting';
        addMessage('awaiting', msg.text || '等待你的确认…');
        break;
      case 'awaitTimeout':
        // Nobody answered the modal. Drop the yellow "waiting" state so it
        // does not look stuck, but leave a visible record of what happened.
        phaseText.textContent = msg.text || '确认超时，本次操作已自动取消';
        phaseText.className = 'ptext';
        phaseDot.className = busy ? 'pdot active' : 'pdot';
        addMessage('awaiting', msg.text || '确认超时，本次操作已自动取消，Agent 继续');
        break;
      case 'progress':
        chars = msg.chars || 0;
        renderTimer();
        break;
      case 'thought':
        addThoughtSeg(msg.text);
        break;
      case 'file':
        var fileEl = addMessage('file', msg.text || '已导入文件');
        if (msg.path) { fileEl.title = msg.path; }
        break;
      case 'userMessage':
        /* 定时任务由宿主发起，webview 没有走过 dispatch()，用户气泡得补上。 */
        addMessage('user', msg.text || '', msg.scheduledAt ? scheduleBadge(msg.scheduledAt) : '');
        hadError = false;
        lastErrorKind = '';
        lastCheck = null;
        currentBubble = null;
        currentRaw = '';
        resetToolDedupe();
        phaseText.textContent = '定时任务开始执行…';
        phaseText.className = 'ptext';
        break;
      case 'replay':
        // The host rebuilt (panel reopened) or switched the session: wipe the
        // transcript and re-render the persisted history so the conversation
        // is not lost with the old DOM. Long imports arrive pre-truncated.
        messagesEl.innerHTML = '';
        currentBubble = null;
        currentRaw = '';
        attachments = [];
        renderAttachments();
        (msg.items || []).forEach(function (it) {
          addMessage(it.role === 'assistant' ? 'assistant' : 'user', it.content || '',
            it.scheduled ? scheduleBadge(it.scheduled) : '');
        });
        scrollDown();
        break;
      case 'attachment':
        upsertAttachment(msg.item);
        break;
      case 'attachments':
        attachments = Array.isArray(msg.items) ? msg.items.slice() : [];
        renderAttachments();
        break;
      case 'attachmentRemoved':
        attachments = attachments.filter(function (a) { return a.id !== msg.id; });
        renderAttachments();
        break;
      case 'lesson':
        /* 菜单按钮计数实时刷新：经验记忆的事件在工具循环里发出，等整轮结束
         * 才由 state 刷新会让人以为「记了但没生效」。count 是宿主持久化后
         * 回传的真实条数，直接用它更新按钮。 */
        if (lessonsBtn && msg.count) {
          lessonsBtn.textContent = '经验记忆 (' + msg.count + ')';
          lessonsBtn.title = '工具报错后被修好时自动总结的经验 ' + msg.count + ' 条（点开可查看或删除）';
        }
        /* 同一类错误又踩了一次（repeated）：命中次数由宿主累加即可，不再往
         * 聊天区重复播报「已存入经验记忆」——那条提示是给「新学到的」看的，
         * 重复出现会被当成又写了一条。 */
        if (msg.repeated) { break; }
        addMessage('lesson', '已存入经验记忆：' + (msg.text || '') +
          (msg.count ? '（共 ' + msg.count + ' 条，可在菜单「经验记忆」里查看或删除）' : ''));
        break;
      case 'snapshot':
        addSnapshotRow(msg.id || '', Array.isArray(msg.files) ? msg.files : []);
        break;
      case 'start':
        abandonPendingTool('已中断');
        closeThoughtSeg();
        currentBubble = addMessage('assistant', '');
        currentRaw = '';
        break;
      case 'delta':
        if (!currentBubble) { currentBubble = addMessage('assistant', ''); currentRaw = ''; }
        currentRaw += msg.text || '';
        renderRich(currentBubble, currentRaw);
        scrollDown();
        break;
      case 'status':
        phaseText.textContent = msg.text || '';
        phaseText.className = 'ptext';
        break;
      case 'tool':
        addToolLine(msg);
        break;
      case 'check':
        lastCheck = msg;
        addCheck(msg);
        break;
      case 'notice':
        // Process notices that are not tool output: auto retry, request retry.
        addMessage('subtask', '[系统] ' + (msg.text || ''));
        phaseText.textContent = msg.text || '';
        phaseText.className = 'ptext awaiting';
        break;
      case 'subtask':
        addMessage('subtask', (msg.status === 'done' ? '✓ ' : '▸ ') + (msg.text || '子任务'));
        phaseText.textContent = msg.text || '';
        phaseText.className = msg.status === 'done' ? 'ptext done' : 'ptext';
        break;
      case 'subtaskEvent':
        if (msg.event && msg.event.type !== 'thought') {
          addMessage('subtask', '↳ ' + (msg.event.text || msg.event.type));
        }
        break;
      case 'queueRejected':
        enqueue(msg.text || '');
        break;
      case 'error':
        hadError = true;
        /* 宿主给的失败类型：timeout / confirm-timeout / cancelled / other。
         * 老宿主没有 kind，按 other 处理（保守：暂停）。 */
        lastErrorKind = msg.kind || (msg.queueSafe ? 'timeout' : 'other');
        abandonPendingTool('已中断');
        closeThoughtSeg();
        addMessage('error', msg.text || 'Unknown error');
        phaseText.textContent = '出错，详见上方红色提示';
        phaseText.className = 'ptext failed';
        phaseDot.className = 'pdot';
        break;
      case 'done':
        abandonPendingTool('已中断');
        closeThoughtSeg();
        // Only a successful, non-empty answer turns green. Errors stay red and
        // cancelled runs are not marked complete. The completion check has the
        // final say: if this round did nothing, do not print "已完成".
        if (!hadError && currentBubble) {
          if (lastCheck && lastCheck.level === 'fail') {
            currentBubble.classList.add('conclusion-warn');
            currentBubble.insertAdjacentHTML('afterbegin',
              '<div class="conclusion-flag warn">未完成（见下方自检）</div>');
          } else if (lastCheck && lastCheck.level === 'warn') {
            currentBubble.classList.add('conclusion-warn');
            currentBubble.insertAdjacentHTML('afterbegin',
              '<div class="conclusion-flag warn">已完成，但有提醒</div>');
          } else {
            currentBubble.classList.add('conclusion-done');
            currentBubble.insertAdjacentHTML('afterbegin',
              '<div class="conclusion-flag">✓ 已完成</div>');
          }
        }
        currentBubble = null;
        currentRaw = '';
        setBusy(false);
        if (!hadError) {
          phaseText.textContent = lastCheck && lastCheck.level === 'fail'
            ? '自检未通过：' + lastCheck.title
            : (lastCheck && lastCheck.level === 'warn'
              ? '完成，但有提醒'
              : '✓ 已完成');
          phaseText.className = lastCheck && lastCheck.level === 'fail' ? 'ptext failed'
            : (lastCheck && lastCheck.level === 'warn' ? 'ptext awaiting' : 'ptext done');
          phaseDot.className = lastCheck && lastCheck.level === 'fail' ? 'pdot' : 'pdot done';
        }
        if (queue.length) {
          /* 这一轮成功了，说明链路本身没问题：把之前因为某次报错 / Stop /
           * 确认超时而挂起的暂停状态一并放行。否则「暂停」会一直粘着——后面
           * 每一轮都成功、却仍然停在「已暂停」，排队的任务永远等一个人来点
           * 「继续队列」，看起来就像成功了也不往下跑。 */
          if (!hadError) {
            queuePaused = false;
            timeoutStreak = 0;
            renderQueue();
          }
          /* 超时不算「队列的错」：上一轮等太久被掐断，和排队的下一条内容无关，
           * 接着发；连续超时到上限（多半是服务已经死了）才停下来等人。 */
          var keepGoing = hadError && lastErrorKind === 'timeout' && timeoutStreak < MAX_TIMEOUT_STREAK;
          if (keepGoing) {
            timeoutStreak += 1;
            addMessage('subtask', '[系统] 上一轮请求超时，队列继续发送剩余 ' + queue.length + ' 条');
            phaseText.textContent = '上一轮超时，继续发送队列剩余 ' + queue.length + ' 条';
            phaseText.className = 'ptext awaiting';
            setTimeout(pumpQueue, 60);
          } else if (hadError) {
            queuePaused = true;
            renderQueue();
            phaseText.textContent = (lastErrorKind === 'timeout'
              ? '连续 ' + timeoutStreak + ' 条请求超时，队列已暂停（点「继续队列」发送剩余 ' + queue.length + ' 条）'
              : '出错了，队列已暂停（点「继续队列」发送剩余 ' + queue.length + ' 条）');
            phaseText.className = 'ptext failed';
          } else {
            /* 这一轮成功了：超时计数清零，下一条立刻发，不等任何点击。 */
            timeoutStreak = 0;
            setTimeout(pumpQueue, 60);
          }
        } else if (!hadError) {
          /* 队列空了也要撤掉暂停标记：下次再排队不该一上来就显示「已暂停」。 */
          queuePaused = false;
          timeoutStreak = 0;
          renderQueue();
        }
        break;
      case 'mentionFiles':
        mentionReady = true;
        mentionError = msg.error ? String(msg.error) : '';
        mentionTruncated = !!msg.truncated;
        mentionTotal = msg.total || (msg.files ? msg.files.length : 0);
        if (msg.files) { mentionFiles = msg.files; }
        // 关键：清单回来时弹层可能正处于「正在读取…」的隐藏/占位状态，
        // 只要用户光标还在 @ 词里就重绘一次，否则首个 @ 永远看不到列表。
        if (currentMention) { renderMention(); }
        break;
      case 'dropResolved':
        // 拖拽文件已由宿主解析成工作区相对路径，逐个变成 @引用 插进输入框
        if (msg.tokens && msg.tokens.length) {
          insertTextAtCaret(msg.tokens.map(function (t) { return '@' + t; }).join(' ') + ' ');
        }
        break;
      case 'sessions':
        // activeId 变了才换屏幕；同一会话只刷新下拉列表（避免误清屏）。
        switchScreen(msg.activeId, msg.count || 0, false);
        renderSessionList(msg.items, msg.activeId);
        break;
      case 'cleared':
        messagesEl.textContent = '';
        if (activeSessionId) { snapshots[activeSessionId] = ''; }
        currentBubble = null;
        currentRaw = '';
        resetSegs();
        hadError = false;
        lastCheck = null;
        resetToolDedupe();
        queue = [];
        queuePaused = false;
        timeoutStreak = 0;
        lastErrorKind = '';
        renderQueue();
        attachments = [];
        renderAttachments();
        phaseText.textContent = '就绪';
        phaseText.className = 'ptext';
        phaseDot.className = 'pdot';
        timerEl.textContent = '';
        resetSegs();
        break;
      default:
        break;
    }
  });

  /* Normalize the composer before the first host message arrives: an empty
   * attachment bar must be invisible even if the markup forgot the attribute. */
  renderAttachments();

  vscode.postMessage({ type: 'ready' });
}());
