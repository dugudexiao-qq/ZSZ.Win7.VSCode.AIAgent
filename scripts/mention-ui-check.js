'use strict';
/* ==========================================================================
   @ 引用前端逻辑的真机级自测（不需要浏览器）
   用最小 DOM 桩把 media/chat.js 原样加载起来，模拟「打字 → 请求清单 →
   宿主回包 → 上下键选择 → 回车插入」全过程，验证：
   1. 首次打 @ 立刻有可见反馈（不是静默无反应）
   2. 宿主回包时弹层即使处于隐藏态也会重绘（v1.7.5 修的问题）
   3. 中文后 / 全角 ＠ 也能触发；邮箱里的 @ 不触发
   4. 上下键 + Enter 正确插入 @相对路径
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEl(id) {
  const el = {
    id: id || '',
    tagName: 'DIV',
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    children: [],
    _handlers: {},
    classList: {
      _set: {},
      add: function (c) { this._set[c] = true; },
      remove: function (c) { delete this._set[c]; },
      toggle: function (c, on) { if (on === undefined) { on = !this._set[c]; } if (on) { this._set[c] = true; } else { delete this._set[c]; } },
      contains: function (c) { return !!this._set[c]; }
    },
    appendChild: function (child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild: function (child) {
      const i = this.children.indexOf(child);
      if (i >= 0) { this.children.splice(i, 1); }
      return child;
    },
    insertBefore: function (child, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; },
    insertAdjacentHTML: function () {},
    addEventListener: function (type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener: function () {},
    setAttribute: function (k, v) { this['attr_' + k] = v; },
    removeAttribute: function () {},
    getAttribute: function (k) { return this['attr_' + k]; },
    focus: function () {},
    blur: function () {},
    closest: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; },
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 400, height: 80, bottom: 80, right: 400 }; },
    scrollIntoView: function () {},
    contains: function () { return false; }
  };
  // firstChild 供「清空子节点」的写法使用
  Object.defineProperty(el, 'firstChild', { get: function () { return this.children.length ? this.children[0] : null; } });
  // 真实 DOM 里 textContent = '' 会清空子节点；桩必须一致，否则「重绘」看起来
  // 像「追加」，会放过重复渲染这类 bug。
  let _text = '';
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get: function () {
      if (this.children.length) {
        return this.children.map(function (c) { return c.textContent; }).join('');
      }
      return _text;
    },
    set: function (v) {
      _text = String(v === undefined || v === null ? '' : v);
      this.children.length = 0;
    }
  });
  // 同理：innerHTML = ''（replay 前清屏）也必须清空 children
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get: function () { return _html; },
    set: function (v) {
      _html = String(v === undefined || v === null ? '' : v);
      if (!_html) { this.children.length = 0; }
    }
  });
  return el;
}

const els = {};
const documentStub = {
  _handlers: {},
  getElementById: function (id) {
    if (!els[id]) {
      els[id] = makeEl(id);
      // 真实 DOM 里 #input 在 .composer 内；@ 弹层挂在它的 parentNode 上
      if (id === 'input') { els[id].parentNode = makeEl('composer'); }
    }
    return els[id];
  },
  createElement: function (tag) { const e = makeEl(''); e.tagName = String(tag || 'div').toUpperCase(); return e; },
  addEventListener: function (type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  removeEventListener: function () {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; }
};

const posted = [];
const windowStub = {
  _handlers: {},
  addEventListener: function (type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  removeEventListener: function () {},
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  MarkdownLite: null,
  matchMedia: function () { return { matches: false, addListener: function () {} }; }
};

const sandbox = {
  document: documentStub,
  window: windowStub,
  navigator: {},
  acquireVsCodeApi: function () {
    return {
      postMessage: function (m) { posted.push(m); },
      setState: function () {},
      getState: function () { return null; }
    };
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  console: console,
  Date: Date,
  Math: Math,
  JSON: JSON,
  String: String,
  Number: Number,
  Object: Object,
  Array: Array,
  RegExp: RegExp
};
sandbox.globalThis = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'chat.js' });

const input = els.input;
assert.ok(input, 'textarea #input must be created');

function fire(el, type, ev) {
  const hs = (el._handlers && el._handlers[type]) || [];
  hs.forEach(function (fn) { fn(ev || { preventDefault: function () {}, stopPropagation: function () {}, key: '', target: el }); });
}
function hostMessage(msg) {
  fire(windowStub, 'message', { data: msg });
}
function typeText(val, caret) {
  input.value = val;
  input.selectionStart = caret === undefined ? val.length : caret;
  input.selectionEnd = input.selectionStart;
  fire(input, 'input');
}
function mentionBox() {
  // 弹层由 ensureMentionEl 动态创建，挂在 input.parentNode 上
  const parent = input.parentNode;
  return parent && parent.children.filter(function (c) { return c.id === 'mention'; })[0];
}
function itemTexts(el) {
  return el ? el.children.map(function (c) { return c.textContent; }) : [];
}

let pass = 0;
function check(name, fn) {
  fn();
  pass += 1;
  console.log('  PASS  ' + name);
}

check('typing @ shows an immediate, visible hint (not a silent no-op)', function () {
  typeText('@');
  const req = posted.filter(function (m) { return m.type === 'mentionQuery'; });
  assert.strictEqual(req.length, 1, 'webview must ask the host for the file list');
  const box = mentionBox();
  assert.ok(box, 'popup element must exist');
  assert.strictEqual(box.hidden, false, 'popup must be visible right away');
  assert.ok(/正在读取工作区文件/.test(box.children[0].textContent), 'hint must say it is loading');
});

check('host reply repaints the list even though the popup was empty before', function () {
  hostMessage({ type: 'mentionFiles', files: ['app.js', 'index.html', 'src/main.js'] });
  const box = mentionBox();
  assert.strictEqual(box.hidden, false);
  assert.deepStrictEqual(itemTexts(box), ['app.js', 'index.html', 'src/main.js'], 'all files listed for an empty query');
});

check('typing filters, arrow keys move, Enter inserts @relative-path', function () {
  typeText('@src');
  let box = mentionBox();
  assert.deepStrictEqual(itemTexts(box), ['src/main.js'], 'query narrows to the one match');
  input.selectionStart = 4;
  fire(input, 'keydown', { preventDefault: function () {}, key: 'Enter', target: input });
  assert.strictEqual(input.value, '@src/main.js ', 'selection must be inserted with a trailing space');
  box = mentionBox();
  assert.strictEqual(box.hidden, true, 'popup closes after insertion');
});

check('Chinese text before @ triggers; email-like @ does not', function () {
  input.value = '';
  posted.length = 0;
  typeText('看看@index');
  let box = mentionBox();
  assert.strictEqual(box.hidden, false, 'CJK boundary must open the picker');
  assert.deepStrictEqual(itemTexts(box), ['index.html']);
  // 邮箱里的 @ 不应触发
  input.value = '';
  typeText('mail me at name@example');
  box = mentionBox();
  assert.strictEqual(box.hidden, true, 'an email must not open the file picker');
});

check('full-width ＠ triggers the picker too', function () {
  input.value = '';
  typeText('引用＠app');
  const box = mentionBox();
  assert.strictEqual(box.hidden, false);
  assert.deepStrictEqual(itemTexts(box), ['app.js']);
});

check('paste event inserts clipboard text at the caret (v1.7.9 paste fix)', function () {
  input.value = '前后';
  input.selectionStart = 1;
  input.selectionEnd = 1;
  posted.length = 0;
  fire(input, 'paste', {
    preventDefault: function () {},
    clipboardData: { getData: function () { return '贴进来的文字'; } }
  });
  assert.strictEqual(input.value, '前贴进来的文字后', 'paste must insert at the caret');
});

check('dropped files ask the host, reply inserts @relative tokens (v1.7.9 drag fix)', function () {
  input.value = '';
  posted.length = 0;
  fire(documentStub, 'drop', {
    preventDefault: function () {},
    stopPropagation: function () {},
    dataTransfer: { files: [{ name: 'index.html', path: 'E:\\tmp\\index.html' }, { name: 'data.csv', path: '' }] }
  });
  const req = posted.filter(function (m) { return m.type === 'dropFiles'; });
  assert.strictEqual(req.length, 1, 'webview must send dropped files to the host');
  assert.strictEqual(req[0].files.length, 2);
  assert.strictEqual(req[0].files[0].name, 'index.html');
  hostMessage({ type: 'dropResolved', tokens: ['public/index.html', 'data.csv'] });
  assert.strictEqual(input.value, '@public/index.html @data.csv ', 'resolved tokens must become @mentions');
});

check('dragover/dragenter keep drag state until drop or leave', function () {
  fire(documentStub, 'dragenter', { preventDefault: function () {} });
  assert.strictEqual(input.classList.contains('dragging'), true);
  fire(documentStub, 'drop', {
    preventDefault: function () {},
    stopPropagation: function () {},
    dataTransfer: { files: [] }
  });
  assert.strictEqual(input.classList.contains('dragging'), false);
});

/* ---- v1.8.0 导入文件：输入框上方的附件条 ---- */

function attachBar() { return els.attachments; }
function chips() {
  const bar = attachBar();
  if (!bar) { return []; }
  return bar.children.filter(function (c) { return c.className === 'achip'; });
}
function chipText(chip) {
  return chip.children.map(function (c) { return c.textContent; }).join(' ');
}

check('imported file shows up as a chip above the input box', function () {
  const bar = attachBar();
  assert.ok(bar, '#attachments must exist in the composer');
  assert.strictEqual(bar.hidden, true, 'empty bar must stay hidden');
  hostMessage({
    type: 'attachment',
    item: { id: 'a1', name: 'docs/spec.md', kind: 'Markdown', chars: 1234, truncated: false }
  });
  assert.strictEqual(bar.hidden, false, 'bar must appear right after an import');
  assert.strictEqual(chips().length, 1);
  const text = chipText(chips()[0]);
  assert.ok(text.indexOf('spec.md') !== -1, 'chip must show the file name: ' + text);
  assert.strictEqual(text.indexOf('docs/'), -1, 'chip must not repeat the folder path: ' + text);
  assert.ok(/Markdown/.test(text) && /1234 字符/.test(text), 'chip must show kind and size: ' + text);
});

check('the same import is never rendered twice (reopen / full-list sync)', function () {
  hostMessage({
    type: 'attachments',
    items: [{ id: 'a1', name: 'docs/spec.md', kind: 'Markdown', chars: 1234 }]
  });
  assert.strictEqual(chips().length, 1, 'id must make the render idempotent');
  hostMessage({
    type: 'attachments',
    items: [
      { id: 'a1', name: 'docs/spec.md', kind: 'Markdown', chars: 1234 },
      { id: 'a2', name: 'data.csv', kind: 'CSV', chars: 88, truncated: true }
    ]
  });
  assert.strictEqual(chips().length, 2, 'a second import must add a second chip');
  assert.ok(/已截断/.test(chipText(chips()[1])), 'truncation must be visible on the chip');
});

check('clicking × asks the host to drop that import, then the chip goes away', function () {
  posted.length = 0;
  const chip = chips()[0];
  const x = chip.children.filter(function (c) { return c.className === 'achip-x'; })[0];
  assert.ok(x, 'every chip needs a remove button');
  fire(x, 'click');
  const req = posted.filter(function (m) { return m.type === 'removeAttachment'; });
  assert.strictEqual(req.length, 1, 'the host must be told which import to drop');
  assert.strictEqual(req[0].id, 'a1');
  hostMessage({ type: 'attachmentRemoved', id: 'a1' });
  assert.strictEqual(chips().length, 1, 'only the removed chip disappears');
  hostMessage({ type: 'attachmentRemoved', id: 'a2' });
  assert.strictEqual(attachBar().hidden, true, 'bar hides again once nothing is attached');
});

check('clear conversation also clears the attachment bar', function () {
  hostMessage({ type: 'attachment', item: { id: 'a3', name: 'x.txt', kind: '文本', chars: 10 } });
  assert.strictEqual(chips().length, 1);
  hostMessage({ type: 'cleared' });
  assert.strictEqual(chips().length, 0, 'stale chips would point at content that is gone');
  assert.strictEqual(attachBar().hidden, true);
});

check('a learned lesson is reported in the transcript, not silently stored', function () {
  hostMessage({ type: 'lesson', text: '单次写入上限 20000 字符：先拆小文件。', count: 3 });
  const msgs = els.messages.children.filter(function (c) { return c.className === 'msg lesson'; });
  assert.strictEqual(msgs.length, 1, 'the user must see what got memorized');
  assert.ok(/已存入经验记忆/.test(msgs[0].textContent));
  assert.ok(/共 3 条/.test(msgs[0].textContent), 'the count tells them where to manage it');
  /* v1.11.1：菜单按钮计数必须实时刷新，不能等整轮结束的 state 才变。 */
  assert.ok(/经验记忆 \(3\)/.test(els.lessons.textContent),
    'the menu button must reflect the new lesson count immediately');
});

check('a repeated lesson refreshes the count without a second transcript line', function () {
  const before = els.messages.children.filter(function (c) { return c.className === 'msg lesson'; }).length;
  /* 同一类错误又踩了一次：宿主回传 repeated=true，只累加命中次数，
   * 聊天区不该再出现一条「已存入经验记忆」。 */
  hostMessage({ type: 'lesson', text: '同一类错误又踩了一次。', count: 4, repeated: true });
  const after = els.messages.children.filter(function (c) { return c.className === 'msg lesson'; }).length;
  assert.strictEqual(after, before, 'a reinforced lesson must not be announced again');
  assert.ok(/经验记忆 \(4\)/.test(els.lessons.textContent),
    'the count still has to move when an existing lesson is hit again');
});

check('a replay event rebuilds the transcript after a reopen or session switch (v1.11.4)', function () {
  // 先在屏幕上放一些旧内容，replay 必须清掉它们而不是追加
  hostMessage({ type: 'delta', text: '这是上一次会话的残留输出' });
  const stale = els.messages.children.length;
  assert.ok(stale > 0, 'precondition: the DOM has stale content');
  hostMessage({
    type: 'replay',
    items: [
      { role: 'user', content: '帮我把配置改成 UTF-8' },
      { role: 'assistant', content: '已改好。' }
    ]
  });
  const kids = els.messages.children;
  assert.strictEqual(kids.length, 2, 'replay wipes the DOM and renders exactly the history');
  assert.strictEqual(kids[0].className, 'msg user');
  assert.strictEqual(kids[1].className, 'msg assistant');
  assert.ok(/帮我把配置改成 UTF-8/.test(kids[0].textContent));
  assert.ok(/已改好/.test(kids[1].textContent));
  // 空历史（新对话）也要清屏
  hostMessage({ type: 'replay', items: [] });
  assert.strictEqual(els.messages.children.length, 0, 'an empty history must clear the transcript');
});

check('thoughts and tool calls interleave inline, collapsed by default (v1.9.0)', function () {
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  hostMessage({ type: 'thought', text: '先读入口文件再判断' });
  hostMessage({ type: 'tool', text: 'tool -> readFile {"path":"src/agent.js"}', status: 'call', tool: 'readFile' });
  hostMessage({ type: 'tool', text: 'const pathUtils = require(...)', status: 'ok', tool: 'readFile' });
  hostMessage({ type: 'start' });
  hostMessage({ type: 'delta', text: '读完了，结论如下' });
  const kids = els.messages.children;
  const segThought = kids[kids.length - 3];
  const segTool = kids[kids.length - 2];
  const bubble = kids[kids.length - 1];
  assert.ok(segThought.className.indexOf('seg-thought') !== -1, 'thought must be an inline segment');
  assert.ok(segTool.className.indexOf('seg-tool') !== -1, 'tool call must be an inline segment');
  assert.ok(bubble.className.indexOf('assistant') !== -1, 'the answer comes after the tool line');
  // 默认折叠：标题可见，正文隐藏
  const tBody = segThought.children[1];
  assert.strictEqual(tBody.hidden, true, 'thought body must start collapsed');
  assert.ok(/思考过程 \(9 字\)/.test(segThought.textContent), 'thought label must show the char count');
  const toolLabel = segTool.children[0].children[1];
  assert.ok(/查看文件：src\/agent\.js/.test(toolLabel.textContent), 'tool head must speak in plain words: ' + toolLabel.textContent);
  assert.ok(/· \d+\.\d s/.test(toolLabel.textContent), 'tool head must show how long it took');
  assert.strictEqual(segTool.children[1].hidden, true, 'tool detail must start collapsed');
  // 点标题展开（事件委托绑在 messagesEl 上；桩的 closest 只认节点自己）
  const toggle = segTool.children[0];
  toggle.closest = function (sel) { return sel === '.seg-toggle' ? toggle : null; };
  fire(els.messages, 'click', { target: toggle });
  assert.strictEqual(segTool.children[1].hidden, false, 'clicking the head must expand the detail');
  assert.ok(/参数：\{"path":"src\/agent\.js"\}/.test(segTool.children[1].textContent), 'expanded view must show the arguments');
  assert.ok(/结果：/.test(segTool.children[1].textContent), 'expanded view must show the result');
  hostMessage({ type: 'done' });
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });  // 收掉计时器，进程才能退出
});

check('sticky scroll only follows at the bottom; reading an expanded section never jumps', function () {
  const m = els.messages;
  m.scrollHeight = 1000;
  m.clientHeight = 200;
  m.scrollTop = 800;                     // 贴底（800 + 200 = 1000）
  fire(m, 'scroll');

  hostMessage({ type: 'start' });
  assert.strictEqual(m.scrollTop, 1000,
    'at the bottom, a new answer line must stay pinned to the end');
  hostMessage({ type: 'delta', text: '正在生成的回答' });
  assert.strictEqual(m.scrollTop, 1000,
    'streaming text must follow while the user is at the bottom');

  // 用户为了阅读展开段向上滚走
  m.scrollTop = 300;
  fire(m, 'scroll');
  m.scrollHeight = 1400;
  hostMessage({ type: 'delta', text: '阅读时新增的内容' });
  assert.strictEqual(m.scrollTop, 300,
    'new content must NOT yank the view while reading above the bottom');

  // 展开一个段落后内容变高：展开动作本身也要关掉跟随
  m.scrollTop = 1200;                    // 贴底（1200 + 200 = 1400）
  fire(m, 'scroll');
  const seg = makeEl();
  const head = makeEl();
  head.className = 'seg-toggle';
  const body = makeEl();
  body.className = 'seg-body';
  body.hidden = true;
  seg.appendChild(head);
  seg.appendChild(body);
  m.appendChild(seg);
  head.closest = function (sel) { return sel === '.seg-toggle' ? head : null; };
  m.scrollHeight = 2000;                 // 展开后正文撑高
  fire(m, 'click', { target: head });
  assert.strictEqual(body.hidden, false, 'precondition: section expanded');
  m.scrollHeight = 2200;                 // 又来新内容
  hostMessage({ type: 'delta', text: '展开后不该跳' });
  assert.strictEqual(m.scrollTop, 1200,
    'expanding a section must stop auto-follow even if the user was at the bottom');

  // 用户把窗口拉到最下面 → 恢复跟随
  m.scrollTop = 2000;                    // 贴底（2000 + 200 = 2200）
  fire(m, 'scroll');
  m.scrollHeight = 2400;
  hostMessage({ type: 'delta', text: '恢复跟随' });
  assert.strictEqual(m.scrollTop, 2400,
    'once the user scrolls back to the bottom, following must resume');

  hostMessage({ type: 'done' });
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });
});

check('a failed tool turns its running line into the failure row, repeats collapse (v1.9.0)', function () {
  hostMessage({ type: 'tool', text: 'tool -> saveText {"path":"a.txt"}', status: 'call', tool: 'saveText' });
  hostMessage({ type: 'tool', text: 'TOOL ERROR: File already exists: a.txt', status: 'failed', tool: 'saveText' });
  let kids = els.messages.children;
  let row = kids[kids.length - 1];
  assert.ok(row.className.indexOf('tool-fail') !== -1, 'the running line must become the failure row itself');
  assert.ok(/· 失败/.test(row.textContent), 'the head must say it failed');
  assert.ok(/文件已存在/.test(row.textContent), 'the Chinese reason must be visible');
  // 原样重试一次：同一行上出现重复计数，而不是刷屏
  hostMessage({ type: 'tool', text: 'tool -> saveText {"path":"a.txt"}', status: 'call', tool: 'saveText' });
  hostMessage({ type: 'tool', text: 'TOOL ERROR: File already exists: a.txt', status: 'failed', tool: 'saveText' });
  kids = els.messages.children;
  row = kids[kids.length - 1];
  assert.ok(/重复 1 次/.test(row.textContent), 'repeated identical failures must collapse with a counter');
  hostMessage({ type: 'done' });
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });  // 收掉计时器，进程才能退出
});

check('snapshot revert row renders and posts revertSnapshot with the row id (v1.10.0)', function () {
  hostMessage({ type: 'busy', value: true });
  hostMessage({ type: 'start' });
  hostMessage({ type: 'snapshot', id: 'snap-test-1', files: ['report.md', 'data/out.csv（新建）'] });
  const kids = els.messages.children;
  const row = kids[kids.length - 1];
  assert.ok(row.className.indexOf('snapshot') !== -1, 'the last row must be the snapshot entry');
  const btn = row.children.filter(function (c) { return c.className === 'snap-undo'; })[0];
  assert.ok(btn, 'the row must contain the undo button');
  assert.strictEqual(btn.getAttribute('data-id'), 'snap-test-1');
  assert.ok(/撤回本轮改动/.test(btn.textContent) && /2 个文件/.test(btn.textContent), 'button text must name the action and count');
  posted.length = 0;
  btn.closest = function (sel) { return sel === '.snap-undo' ? btn : null; };  // 桩 closest 默认返 null，覆写以命中委托
  fire(els.messages, 'click', { target: btn });
  const req = posted.filter(function (m) { return m.type === 'revertSnapshot'; });
  assert.strictEqual(req.length, 1, 'clicking undo must ask the host to revert');
  assert.strictEqual(req[0].id, 'snap-test-1');
  assert.strictEqual(btn.disabled, true, 'the button must disable immediately to avoid double-revert');
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });
});

check('profiles menu button exists and posts the profiles message (v1.10.0)', function () {
  const btn = documentStub.getElementById('profiles');
  assert.ok(btn, 'the menu must contain the model-profile switcher');
  posted.length = 0;
  fire(btn, 'click');
  const req = posted.filter(function (m) { return m.type === 'profiles'; });
  assert.strictEqual(req.length, 1, 'clicking the button must open the profile switcher');
});

/* ---- v1.12.5 发送按钮不因忙碌改名 ---- */

check('the Send button keeps its name while a reply is running', function () {
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  assert.strictEqual(els.send.textContent, 'Send',
    'renaming Send to 排队 makes the send box look like a different action');
  assert.ok(/排到这一轮/.test(els.send.title || ''), 'the tooltip must explain that it queues');
  hostMessage({ type: 'busy', value: false, elapsedMs: 1200 });
  assert.strictEqual(els.send.textContent, 'Send');
});

/* ---- v1.13.9 点发送后 Stop 立即可用 ---- */

check('Stop is enabled the instant a request is sent, not after the model starts', function () {
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });
  assert.strictEqual(els.stop.disabled, true, 'precondition: Stop starts disabled when idle');

  input.value = '读一下 src/a.js';
  input.selectionStart = input.value.length;
  const before = posted.length;
  fire(els.send, 'click');
  assert.ok(posted.slice(before).some(function (m) { return m.type === 'send'; }),
    'clicking Send must actually dispatch the request');
  assert.strictEqual(els.stop.disabled, false,
    'Stop must be usable while waiting for the model, not only after the first token');
  assert.strictEqual(els.send.disabled, false, 'Send must stay enabled so follow-ups can queue');

  hostMessage({ type: 'done' });
  assert.strictEqual(els.stop.disabled, true, 'a finished round must disable Stop again');
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });
});

/* ---- v1.12.7 顶端记忆容量条 ---- */

check('the memory bar reports what was forgotten or compressed, not a stuck 100%', function () {
  hostMessage({
    type: 'memory',
    memory: {
      used: 120000, committed: 120000, limit: 280000, percent: 43,
      included: 120000, includedMessages: 12, messages: 12,
      messageLimit: 100, dropped: 0, forgottenCount: 0, forgotten: [],
      compressedCount: 0, compressed: [], summarized: false
    }
  });
  assert.strictEqual(els.memfill.style.width, '43%', 'without loss the bar still tracks used/limit');
  assert.ok(/完整保留/.test(els.memtext.textContent),
    'a healthy context should say so in words: ' + els.memtext.textContent);
  assert.ok(!/记忆 \d+%|100%/.test(els.memtext.textContent),
    'the main label must not be a meaningless percentage');
  assert.ok(!/warn|full/.test(els.membar.className), 'mid-range usage must stay neutral');
  assert.ok(/maxContextChars/.test(els.membar.title), 'the tooltip must name the setting that sets the cap');
  assert.ok(els.memdetail.hidden, 'no loss means no detail list');

  /* 80% 起提醒：AI 快开始忘掉开头了。 */
  hostMessage({ type: 'memory', memory: { used: 240000, limit: 280000, percent: 86, messages: 40, dropped: 0, messageLimit: 100 } });
  assert.ok(/warn/.test(els.membar.className), 'past 80% the bar must warn');
  assert.strictEqual(els.memfill.style.width, '86%');

  /* 真正有用的信息：谁被遗忘、谁被压缩，并给出可展开的逐条摘要。 */
  hostMessage({
    type: 'memory',
    memory: {
      used: 300000, committed: 300000, limit: 280000, percent: 100,
      included: 150000, includedMessages: 8, messages: 130, dropped: 12,
      messageLimit: 100,
      forgottenCount: 12,
      forgotten: [
        { role: '用户', text: '帮我分析旧版 readFile 的问题' },
        { role: '助手', text: '先看一下工具协议定义' }
      ],
      compressedCount: 40,
      compressed: [{ role: '用户', text: '最早的需求清单' }]
    }
  });
  assert.ok(/full/.test(els.membar.className), 'dropped turns must be flagged, not hidden behind 100%');
  assert.ok(/遗忘 12 条/.test(els.memtext.textContent) && /压缩 40 条/.test(els.memtext.textContent),
    'the label must name what happened: ' + els.memtext.textContent);
  assert.ok(!/记忆已满/.test(els.memtext.textContent), 'a stuck "100%" label is not information');
  assert.strictEqual(els.memfill.style.width, '50%', 'the fill must now show the retained half of history');
  assert.ok(/已遗忘/.test(els.membar.title) && /readFile/.test(els.membar.title),
    'the tooltip must say which content no longer reaches the model');
  assert.ok(/已压缩/.test(els.membar.title) && /需求清单/.test(els.membar.title),
    'the tooltip must say what was folded into the summary');
  assert.ok(!els.memdetail.hidden && !els.memdetailitems.hidden,
    'the first loss must expand the details instead of hiding them in a tooltip');
  assert.ok(/遗忘 12 条/.test(els.memdetailcount.textContent), 'the detail head must carry the count');
  assert.ok(els.memdetailitems.children.length >= 2, 'both forgotten and compressed groups must be listed');

  fire(els.memdetailhead, 'click');
  assert.ok(els.memdetailitems.hidden && els.memdetailhead.getAttribute('aria-expanded') === 'false',
    'the user can collapse the detail list');
  fire(els.memdetailhead, 'click');
  assert.ok(!els.memdetailitems.hidden, 'and open it again');

  /* 一轮进行中：工具结果与正在生成的回复已经占着上下文，但还没落库。 */
  hostMessage({ type: 'memory', memory: { used: 123000, committed: 120000, live: 3000, limit: 280000, percent: 44, messages: 12, dropped: 0 } });
  assert.ok(/生成中/.test(els.memtext.textContent), 'an in-flight turn must be marked as such: ' + els.memtext.textContent);
  assert.ok(/3000 字符是本轮进行中/.test(els.membar.title), 'the tooltip must explain the live part: ' + els.membar.title);
  assert.ok(els.memdetail.hidden, 'clearing the loss must hide the detail list again');

  /* 空对话不该显示成「快满了」。 */
  hostMessage({ type: 'memory', memory: { used: 0, limit: 280000, percent: 0, messages: 0, dropped: 0 } });
  assert.strictEqual(els.memfill.style.width, '0%');
  assert.ok(/新对话/.test(els.memtext.textContent));
});

/* ---- v1.13.5：最小化按钮有 bug，整个入口撤掉 ---- */
check('the header no longer exposes a minimize button', function () {
  const chatViewSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
  assert.ok(chatViewSrc.indexOf('id="minimize"') === -1,
    'the header must not render the buggy minimize button');
  assert.ok(src.indexOf("getElementById('minimize')") === -1,
    'no click handler should be left for a button that does not exist');
  assert.ok(!els.minimize, 'the UI stub must never have been asked for a minimize button');
});

/* ---- v1.13.0 上下文预算不再占用界面：只在改设置时提醒 ---- */

check('the panel carries no context-budget control', function () {
  assert.ok(src.indexOf('memrec') === -1,
    'the memory bar must not grow a recommendation button: the budget is a setup-time decision');
  assert.ok(src.indexOf('applyContextLimit') === -1,
    'the webview must not post settings changes; the host handles the advisory');
});

/* ---- v1.12.0 定时任务：发送行入口 + 定时气泡角标 ---- */

check('the composer hands the typed task to the scheduler, and refuses an empty box', function () {
  const btn = els.schedbtn;
  assert.ok(btn, 'the composer must contain the 定时 button');
  posted.length = 0;
  input.value = '   ';
  fire(btn, 'click');
  assert.strictEqual(posted.filter(function (m) { return m.type === 'scheduleDraft'; }).length, 0,
    'an empty composer must not open the time picker');
  assert.ok(/先在输入框写好/.test(els.phaseText.textContent), 'the status line must say what is missing');

  input.value = '把 docs 下的链接检查一遍';
  fire(btn, 'click');
  const req = posted.filter(function (m) { return m.type === 'scheduleDraft'; });
  assert.strictEqual(req.length, 1);
  assert.strictEqual(req[0].text, '把 docs 下的链接检查一遍');
});

check('a scheduled turn carries a clock badge, live and after a replay', function () {
  const at = new Date(2026, 10, 26, 2, 0, 0, 0).getTime();
  hostMessage({ type: 'userMessage', text: '夜里跑的任务', scheduledAt: at });
  let users = els.messages.children.filter(function (c) { return c.className === 'msg user'; });
  let last = users[users.length - 1];
  assert.ok(/02:00/.test(last.textContent), 'the badge must show the fire time: ' + last.textContent);
  assert.ok(/定时/.test(last.textContent), 'the badge must say 定时');
  /* Win7 的字体不一定有 U+23F0（闹钟 emoji）：缺字时是一个豆腐块，字形还是
   * 黑白的。角标只用文字，别再引入任何 emoji。 */
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/u.test(last.textContent),
    'the badge must not depend on emoji glyphs the Win7 fonts may lack: ' + last.textContent);
  assert.ok(/夜里跑的任务/.test(last.textContent), 'the task text must still be there');

  hostMessage({ type: 'replay', items: [
    { role: 'user', content: '历史里的定时任务', scheduled: at },
    { role: 'assistant', content: '跑完了。' }
  ] });
  users = els.messages.children.filter(function (c) { return c.className === 'msg user'; });
  assert.strictEqual(users.length, 1);
  assert.ok(/02:00/.test(users[0].textContent), 'a replayed scheduled turn must keep its badge');
});

/* ---- v1.11.18 队列策略：超时继续，其它错误暂停 ----
 * 用真 DOM 桩跑 media/chat.js，模拟「一轮超时 + 队列里还有消息」，
 * 断言下一条会被真的发出去，而不是停在「已暂停」。 */

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function queueHead() {
  const box = els.queue;
  return box && !box.hidden ? box.children[0] : null;
}
function queuePaused() {
  const head = queueHead();
  return !!(head && /已暂停/.test(head.textContent));
}
function sendsAfter(mark) {
  return posted.slice(mark).filter(function (m) { return m.type === 'send'; });
}
/* 模拟一轮结束：先 busy，再把一条消息塞进队列，然后按给定类型报错收尾。 */
async function round(kind, text, queuedText) {
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  input.value = queuedText;
  fire(els.send, 'click');
  assert.ok(els.queue.hidden === false, 'precondition: the message must be queued');
  const mark = posted.length;
  hostMessage({ type: 'error', text: text, kind: kind });
  hostMessage({ type: 'done' });
  await tick(120);
  return sendsAfter(mark);
}

/* ---- v1.13.2 面板顶部展示已排定的定时任务 ---- */

check('the schedule strip is hidden when nothing is scheduled', function () {
  hostMessage({ type: 'schedules', items: [] });
  assert.strictEqual(els.schedlist.hidden, true,
    'an empty schedule must not take panel space');
});

check('scheduled tasks render as clickable rows with time, repeat and paused state', function () {
  hostMessage({ type: 'schedules', items: [
    { id: 'j1', when: '明天 02:00', gap: '（还有 7 小时）', repeat: '每天', disabled: false,
      short: '检查所有失效链接', text: '检查所有失效链接', full: '明天 02:00 · 每天' },
    { id: 'j2', when: '12-01 09:00', gap: '（还有 3 天）', repeat: '仅一次', disabled: true,
      short: '跑一次批处理', text: '跑一次批处理', full: '12-01 09:00 · 仅一次' }
  ] });
  assert.strictEqual(els.schedlist.hidden, false, 'the strip must appear once a task exists');
  assert.ok(/定时任务 2/.test(els.schedcount.textContent), 'the count must be visible');
  assert.ok(/明天 02:00/.test(els.schednext.textContent),
    'collapsed header still names the next fire time, not just a count');
  assert.strictEqual(els.scheditems.children.length, 2, 'one row per scheduled task');
  const row0 = els.scheditems.children[0];
  const row1 = els.scheditems.children[1];
  assert.ok(/每天/.test(row0.children[0].children[0].textContent) && !/disabled/.test(row0.className),
    'an enabled task shows its repeat rule');
  assert.ok(/已暂停/.test(row1.children[0].children[0].textContent) && /disabled/.test(row1.className),
    'a paused task must be visibly marked, not silently listed');
  assert.strictEqual(row0.children[0].children[1].textContent, '检查所有失效链接', 'the text snippet must be shown');
  assert.strictEqual(row0.children[1].children.length, 3, 'each row needs up / down / undo controls');

  posted.length = 0;
  fire(row0.children[1].children[2], 'click');
  assert.strictEqual(posted[0].type, 'scheduleAction', 'the ✕ control must ask the host to undo');
  assert.strictEqual(posted[0].action, 'delete');
  assert.strictEqual(posted[0].id, 'j1');

  posted.length = 0;
  fire(row0, 'click');
  assert.strictEqual(posted.length, 1, 'clicking a row must open the manager');
  assert.strictEqual(posted[0].type, 'scheduleManage');
  assert.strictEqual(posted[0].id, 'j1', 'the clicked task id must reach the host, not just any task');
});

check('a due job waiting on the current turn is visible and editable', function () {
  hostMessage({ type: 'autoQueue', items: [
    { id: 'q1', text: '等待中的批处理', when: '02:00 已到点', full: '等待中的批处理' },
    { id: 'q2', text: '第二条', when: '02:01 已到点', full: '第二条' }
  ] });
  assert.strictEqual(els.autolist.hidden, false, 'the pending queue must appear while a turn is running');
  assert.ok(/定时待执行 2/.test(els.autocount.textContent), 'the pending count must be visible');
  assert.strictEqual(els.autoitems.children.length, 2, 'one row per queued job');
  const row = els.autoitems.children[1];
  assert.ok(/第二条/.test(row.children[0].textContent), 'queued text must be shown');
  posted.length = 0;
  fire(row.children[1].children[0], 'click');
  assert.strictEqual(posted[0].type, 'autoQueueAction');
  assert.strictEqual(posted[0].action, 'up');
  assert.strictEqual(posted[0].id, 'q2');
  fire(row.children[1].children[2], 'click');
  assert.strictEqual(posted[1].action, 'remove', 'queued jobs must be undoable before they start');

  hostMessage({ type: 'autoQueue', items: [] });
  assert.strictEqual(els.autolist.hidden, true, 'an empty pending queue must not take panel space');
});

check('the strip collapses by default and remembers the user choice across refreshes', function () {
  assert.strictEqual(els.scheditems.hidden, true, 'rows start collapsed so the strip stays one line');
  fire(els.schedhead, 'click');
  assert.strictEqual(els.scheditems.hidden, false, 'the header toggles rows open');
  hostMessage({ type: 'schedules', items: [
    { id: 'j1', when: '明天 02:00', gap: '', repeat: '每天', disabled: false, short: 'x', text: 'x', full: 'x' }
  ] });
  assert.strictEqual(els.scheditems.hidden, false,
    'a state refresh must not reopen/close a strip the user already toggled');
  fire(els.schedhead, 'click');
  assert.strictEqual(els.scheditems.hidden, true, 'the header toggles rows closed again');
});

const scenarios = [];
function checkAsync(name, fn) { scenarios.push({ name: name, fn: fn }); }

checkAsync('a timed-out turn keeps the queue running instead of pausing it (v1.11.18)', async function () {
  hostMessage({ type: 'cleared' });
  posted.length = 0;
  const sends = await round('timeout',
    'Network problem: ETIMEDOUT: total request time exceeded 1000000 ms.', '接着做第二件事');
  assert.strictEqual(sends.length, 1, 'the queued message must be sent after a timeout');
  assert.strictEqual(sends[0].text, '接着做第二件事');
  assert.strictEqual(queuePaused(), false, 'the queue must not be paused by a timeout');
  const notes = els.messages.children.filter(function (c) { return c.className === 'msg subtask'; });
  assert.ok(notes.some(function (n) { return /超时/.test(n.textContent) && /队列继续发送/.test(n.textContent); }),
    'the transcript must say why it kept going');
});

checkAsync('authentication errors still pause the queue (no point hammering a dead key)', async function () {
  hostMessage({ type: 'cleared' });
  posted.length = 0;
  const sends = await round('other',
    'Authentication failed (HTTP 401). Check the API key with the "Set API Key" command.', '这条不该自动发');
  assert.strictEqual(sends.length, 0, 'a 401 must not be retried by the queue');
  assert.strictEqual(queuePaused(), true, 'the queue must pause and wait for a human');
  const head = queueHead();
  const resume = head.children.filter(function (c) { return c.className === 'qbtn'; })[0];
  assert.ok(resume && resume.hidden === false, 'the resume button must be offered');
});

checkAsync('a confirm-timeout is treated like a human decision, not like a slow model', async function () {
  hostMessage({ type: 'cleared' });
  posted.length = 0;
  const sends = await round('confirm-timeout',
    'CONFIRM TIMEOUT: nobody answered the write confirmation within 300 s.', '这条也不该自动发');
  assert.strictEqual(sends.length, 0, 'an unanswered dialog must not auto-continue');
  assert.strictEqual(queuePaused(), true);
});

checkAsync('after repeated timeouts the queue pauses, so a dead server is not hammered', async function () {
  hostMessage({ type: 'cleared' });
  const msg = 'Cannot reach the local model server (ETIMEDOUT: no data for 1000000 ms).';
  posted.length = 0;
  let sends = await round('timeout', msg, '第一条');
  assert.strictEqual(sends.length, 1, 'first timeout: keep going');
  sends = await round('timeout', msg, '第二条');
  assert.strictEqual(sends.length, 1, 'second timeout: still keep going');
  sends = await round('timeout', msg, '第三条');
  assert.strictEqual(sends.length, 0, 'the third consecutive timeout must stop the queue');
  assert.strictEqual(queuePaused(), true);
  assert.ok(/连续 \d+ 条请求超时/.test(els.phaseText.textContent),
    'the phase line must explain the pause: ' + els.phaseText.textContent);
});

checkAsync('a successful turn clears a pause left behind by an earlier failure (v1.12.1)', async function () {
  /* 老问题：某次报错（401 / Stop / 确认超时）把队列标成「已暂停」，之后每一轮
   * 都成功了，暂停标记却一直粘着——排队的第二条永远停在「待发送」，看起来
   * 就是「成功了也不往下跑」。成功即放行。 */
  hostMessage({ type: 'cleared' });
  posted.length = 0;
  let sends = await round('other', 'Authentication failed (HTTP 401).', '被暂停的那条');
  assert.strictEqual(sends.length, 0, 'precondition: the failure pauses the queue');
  assert.strictEqual(queuePaused(), true, 'precondition: the queue is paused');

  /* 用户手动发一条（这一步成功），队列里还留着上一条。 */
  input.value = '手动补发的一条';
  fire(els.send, 'click');
  assert.ok(sendsAfter(0).some(function (m) { return m.text === '手动补发的一条'; }),
    'a manual send while paused must still go out');
  const mark = posted.length;
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  hostMessage({ type: 'start' });
  hostMessage({ type: 'delta', text: '好了' });
  hostMessage({ type: 'done' });
  await tick(120);
  sends = sendsAfter(mark);
  assert.strictEqual(queuePaused(), false, 'a successful turn must drop the stale pause');
  assert.strictEqual(sends.length, 1, 'the queued message must follow the success');
  assert.strictEqual(sends[0].text, '被暂停的那条');
});

checkAsync('a successful turn starts the next queued message right away (v1.12.1)', async function () {
  hostMessage({ type: 'cleared' });
  posted.length = 0;
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  hostMessage({ type: 'start' });
  hostMessage({ type: 'delta', text: '第一件事做完了' });
  input.value = '接着做第二件事';
  fire(els.send, 'click');
  assert.strictEqual(els.queue.hidden, false, 'precondition: the message must be queued');
  const mark = posted.length;
  hostMessage({ type: 'done' });
  await tick(120);
  const sends = sendsAfter(mark);
  assert.strictEqual(sends.length, 1, 'success must not strand the queue');
  assert.strictEqual(sends[0].text, '接着做第二件事');
  assert.strictEqual(queuePaused(), false);
});

checkAsync('one successful turn resets the streak, so a later timeout still continues', async function () {
  hostMessage({ type: 'cleared' });
  hostMessage({ type: 'busy', value: true, startedAt: Date.now() });
  hostMessage({ type: 'start' });
  hostMessage({ type: 'delta', text: '好的' });
  hostMessage({ type: 'done' });
  const sends = await round('timeout', 'ETIMEDOUT: no data for 1000000 ms.', '成功之后的一条');
  assert.strictEqual(sends.length, 1, 'the counter must reset after a successful round');
  assert.strictEqual(queuePaused(), false);
});

(async function () {
  let failure = null;
  for (const sc of scenarios) {
    try {
      await sc.fn();
      pass += 1;
      console.log('  PASS  ' + sc.name);
    } catch (err) {
      console.error('  FAIL  ' + sc.name + '\n        ' + (err && err.message ? err.message : err));
      process.exitCode = 1;
      failure = err;
      break;
    }
  }
  /* 收掉计时器（busy 的 setInterval 会把进程挂住，失败时尤其明显）。 */
  hostMessage({ type: 'busy', value: false, elapsedMs: 100 });
  await tick(20);
  if (!failure) { console.log('\nMention UI check passed: ' + pass + ' scenarios.'); }
})();
