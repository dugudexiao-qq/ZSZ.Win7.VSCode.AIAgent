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

console.log('\nMention UI check passed: ' + pass + ' scenarios.');
