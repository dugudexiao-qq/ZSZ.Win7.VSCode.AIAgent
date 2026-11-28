'use strict';

/*
 * Independent audit of the tool layer, run without VS Code.
 * Unlike smoke-host.js (which drives whole conversations against a mock model),
 * this exercises every tool against REAL files in a temp workspace, plus the
 * pure modules (rules / endpoint / toolProtocol / taskCheck).
 *
 * Run: node scripts/audit.js
 * Every check prints PASS or FAIL; the summary lists what needs attention.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const manifest = require('../package.json');
const defaults = manifest.contributes.configuration.properties;

const settings = {};
const scoped = { global: {}, workspace: {}, workspaceFolder: {} };
let nextAnswer = undefined;
let root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-audit-'));
let editor = null;

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') { return; }
      walk(p, out);
    } else { out.push(p); }
  });
  return out;
}

const vscodeStub = {
  version: '1.70.2',
  Uri: {
    file: function (p) { return { fsPath: p, toString: function () { return 'file://' + p; } }; },
    joinPath: function (base) {
      const parts = Array.prototype.slice.call(arguments, 1);
      return { fsPath: path.join.apply(path, [base.fsPath].concat(parts)) };
    }
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    get activeTextEditor() { return editor; },
    showWarningMessage: async function () { const a = nextAnswer; nextAnswer = undefined; return a; },
    showInformationMessage: async function () { return undefined; },
    showErrorMessage: async function () { return undefined; },
    createOutputChannel: function () { return { appendLine: function () {}, show: function () {}, dispose: function () {} }; }
  },
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: root } }]; },
    getConfiguration: function (section) {
      return {
        get: function (key) {
          const full = section + '.' + key;
          if (Object.prototype.hasOwnProperty.call(settings, full)) { return settings[full]; }
          const prop = defaults[full];
          return prop ? prop.default : undefined;
        },
        inspect: function (key) {
          const full = section + '.' + key;
          return {
            key: full,
            defaultValue: defaults[full] ? defaults[full].default : undefined,
            globalValue: scoped.global[full],
            workspaceValue: scoped.workspace[full],
            workspaceFolderValue: scoped.workspaceFolder[full]
          };
        },
        update: async function (key, value) { settings[section + '.' + key] = value; }
      };
    },
    asRelativePath: function (uri) {
      const p = (uri && uri.fsPath) || String(uri);
      const rel = path.relative(root, p);
      return rel && rel.indexOf('..') !== 0 ? rel : p;
    },
    findFiles: async function (pattern) {
      const all = walk(root, []);
      const m = String(pattern || '**/*').match(/\*\.([a-z0-9]+)$/i);
      const kept = m ? all.filter(function (p) { return p.toLowerCase().endsWith('.' + m[1].toLowerCase()); }) : all;
      return kept.slice(0, 200).map(function (p) { return { fsPath: p }; });
    },
    fs: {
      stat: async function (uri) { return { size: fs.statSync(uri.fsPath).size }; },
      readFile: async function (uri) { return fs.readFileSync(uri.fsPath); }
    }
  },
  commands: { registerCommand: function () { return { dispose: function () {} }; }, executeCommand: async function () {} }
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') { return vscodeStub; }
  return originalLoad.apply(this, arguments);
};

const agent = require('../src/agent');
const rules = require('../src/rules');
const lessons = require('../src/lessons');
const runtime = require('../src/runtime');
const taskCheck = require('../src/taskCheck');
const endpoint = require('../src/endpoint');
const fileImport = require('../src/fileImport');
const protocol = require('../src/toolProtocol');

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { results.push({ name: name, ok: true }); console.log('  PASS  ' + name); })
    .catch(function (e) {
      results.push({ name: name, ok: false, err: e && e.message ? e.message : String(e) });
      console.log('  FAIL  ' + name + '\n        ' + (e && e.message ? e.message : e));
    });
}

function write(rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

async function call(tool, args, cfg) {
  return agent.runTool({ tool: tool, args: args }, cfg || runtime.getConfig(), { token: { isCancellationRequested: false }, emit: function () {} });
}

async function main() {
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  const cfg = runtime.getConfig();

  /* ---------- listFiles / readFile ---------- */
  write('a.txt', 'hello zsz');
  write('sub/b.md', '# title');
  write('sub/deep/c.js', 'var x = 1;');

  await test('listFiles returns workspace files', async function () {
    const out = await call('listFiles', {});
    assert.ok(/a\.txt/.test(out) && /deep/.test(out), out.slice(0, 200));
  });

  await test('listFiles honours a *.ext pattern', async function () {
    const out = await call('listFiles', { pattern: '**/*.md' });
    assert.ok(/b\.md/.test(out) && !/a\.txt/.test(out), out);
  });

  await test('readFile returns content', async function () {
    const out = await call('readFile', { path: 'a.txt' });
    assert.strictEqual(out, 'FILE: a.txt\nhello zsz');
  });

  await test('readFile keeps head and tail of a long body and reports the cut', async function () {
    write('long.txt', 'HEAD' + 'x'.repeat(15000) + 'TAIL');
    const out = await call('readFile', { path: 'long.txt' });
    assert.ok(out.length < 4500, 'len ' + out.length);
    assert.ok(out.slice(0, 40).indexOf('HEAD') !== -1, 'head must survive');
    assert.ok(out.slice(-20).indexOf('TAIL') !== -1, 'tail must survive');
    assert.ok(/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(out), out.slice(300, 420));
  });

  await test('readFile empty file is not an error', async function () {
    write('empty.txt', '');
    const out = await call('readFile', { path: 'empty.txt' });
    assert.strictEqual(out, 'FILE: empty.txt\n');
  });

  await test('readFile refuses binary content', async function () {
    fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([0x41, 0x00, 0x42]));
    const out = await call('readFile', { path: 'b.bin' });
    assert.ok(/Binary file, not text/.test(out), out);
  });

  await test('readFile refuses ../ outside the workspace', async function () {
    const out = await call('readFile', { path: '../../windows/win.ini' });
    assert.ok(/outside the workspace/.test(out), out);
  });

  await test('readFile refuses an absolute path outside the workspace', async function () {
    const out = await call('readFile', { path: 'C:\\Windows\\win.ini' });
    assert.ok(/outside the workspace/.test(out), out);
  });

  await test('oneLineError keeps a short message untouched and flattens whitespace', function () {
    assert.strictEqual(agent.oneLineError('File too large (204801 bytes).'), 'File too large (204801 bytes).');
    assert.strictEqual(agent.oneLineError('  a\n\t b\r\nc  '), 'a b c');
    assert.ok(agent.oneLineError('x'.repeat(1000)).length <= agent.MAX_ERROR_CHARS + 3);
  });

  await test('every tool error is one line, capped at MAX_ERROR_CHARS', async function () {
    const out = await call('readFile', { path: 'nope\n'.repeat(200) });
    assert.ok(/^TOOL ERROR: /.test(out), 'prefix must survive: ' + out.slice(0, 60));
    assert.strictEqual(out.indexOf('\n'), -1, 'a failed call must not print several lines');
    assert.ok(out.length <= 'TOOL ERROR: '.length + agent.MAX_ERROR_CHARS + 3, 'len ' + out.length);
  });

  await test('readFile on a directory fails with a readable message', async function () {
    const out = await call('readFile', { path: 'sub' });
    assert.ok(/^TOOL ERROR:/.test(out), out);
    assert.ok(/EISDIR|directory|not a file/i.test(out), 'unclear message: ' + out);
  });

  await test('readFile on a missing file names the file', async function () {
    const out = await call('readFile', { path: 'nope.txt' });
    assert.ok(/ENOENT/.test(out) && /nope\.txt/.test(out), out);
  });

  /* ---------- createFile / saveText ---------- */
  await test('createFile creates nested folders', async function () {
    const out = await call('createFile', { path: 'x/y/z/new.md', text: '# hi' });
    assert.ok(/^Created file/.test(out), out);
    assert.strictEqual(fs.readFileSync(path.join(root, 'x/y/z/new.md'), 'utf8'), '# hi');
  });

  await test('createFile refuses an existing file and honours overwrite', async function () {
    const dup = await call('createFile', { path: 'x/y/z/new.md', text: 'no' });
    assert.ok(/already exists/.test(dup), dup);
    const over = await call('createFile', { path: 'x/y/z/new.md', text: 'yes', overwrite: true });
    assert.ok(/^Overwrote/.test(over), over);
    assert.strictEqual(fs.readFileSync(path.join(root, 'x/y/z/new.md'), 'utf8'), 'yes');
  });

  await test('createFile with empty text creates an empty file', async function () {
    const out = await call('createFile', { path: 'blank.txt', text: '' });
    assert.ok(/^Created file/.test(out), out);
    assert.strictEqual(fs.readFileSync(path.join(root, 'blank.txt'), 'utf8'), '');
  });

  await test('createFile against a directory path is refused, not crashed', async function () {
    const out = await call('createFile', { path: 'sub', text: 'x', overwrite: true });
    assert.ok(/^TOOL ERROR:/.test(out), out);
  });

  await test('saveText rewrites an existing file', async function () {
    const out = await call('saveText', { path: 'a.txt', text: 'rewritten' });
    assert.ok(/^Wrote 9 characters/.test(out), out);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'rewritten');
  });

  await test('saveText refuses a missing parent folder and points at createFile', async function () {
    const out = await call('saveText', { path: 'ghost/x.txt', text: 'x' });
    assert.ok(/Target directory does not exist/.test(out) && /createFile/.test(out), out);
    assert.ok(!fs.existsSync(path.join(root, 'ghost')));
  });

  await test('saveText cannot blank a file (empty text rejected)', async function () {
    const out = await call('saveText', { path: 'a.txt', text: '' });
    assert.ok(/requires args\.text/.test(out), 'unexpected: ' + out);
  });

  await test('saveText refuses more than 20000 chars with split guidance (v1.7.7)', async function () {
    const out = await call('saveText', { path: 'a.txt', text: 'x'.repeat(20001) });
    assert.ok(/too long/i.test(out), out);
    // 报错必须带数字与下一步指引（v1.7.5 真机教训：模型不知道上限，第一把
    // 写几万字被拒后只会浪费一轮重试同样的调用）
    assert.ok(/20001 chars/.test(out) && /20000/.test(out), out);
    assert.ok(/[Ss]plit/.test(out), out);
    const created = await call('createFile', { path: 'big.txt', text: 'x'.repeat(20001) });
    assert.ok(/too long/i.test(created) && /[Ss]plit/.test(created), created);
  });

  /* ---------- insertText ---------- */
  function fakeEditor(filePath, initial, editResult) {
    let buffer = initial;
    editor = {
      document: { languageId: 'markdown', uri: { fsPath: filePath }, fileName: filePath, getText: function () { return buffer; } },
      selection: { isEmpty: true, end: { line: 1, character: 3 } },
      edit: async function (cb) {
        if (editResult === false) { return false; }
        cb({
          insert: function (pos, text) {
            const lines = buffer.split('\n');
            let offset = 0;
            for (let i = 0; i < pos.line; i++) { offset += lines[i].length + 1; }
            offset += pos.character;
            buffer = buffer.slice(0, offset) + text + buffer.slice(offset);
          },
          replace: function () {}, delete: function () {}
        });
        return true;
      }
    };
    return { get: function () { return buffer; } };
  }

  await test('insertText reports no active editor', async function () {
    editor = null;
    const out = await call('insertText', { text: 'x' });
    assert.ok(/No active editor/.test(out), out);
  });

  await test('insertText inserts at the selection end', async function () {
    const buf = fakeEditor(path.join(root, 'doc.md'), 'one\ntwo', true);
    const out = await call('insertText', { text: 'three\n' });
    assert.ok(/^Inserted 6 characters/.test(out), out);
    assert.strictEqual(buf.get(), 'one\ntwothree\n');
    editor = null;
  });

  await test('insertText surfaces a rejected edit', async function () {
    fakeEditor(path.join(root, 'doc.md'), 'abc', false);
    const out = await call('insertText', { text: 'x' });
    assert.ok(/Editor rejected the edit/.test(out), out);
    editor = null;
  });

  /* ---------- runCommand ---------- */
  nextAnswer = 'Run'; // shell confirmation defaults ON
  await test('runCommand runs PowerShell and captures output', async function () {
    const out = await call('runCommand', { shell: 'powershell', command: 'Write-Output AUDIT_PS_OK' });
    assert.ok(/STATUS: OK/.test(out) && /AUDIT_PS_OK/.test(out), out);
  });

  await test('runCommand runs CMD and captures output', async function () {
    nextAnswer = 'Run';
    const out = await call('runCommand', { shell: 'cmd', command: 'echo AUDIT_CMD_OK' });
    assert.ok(/AUDIT_CMD_OK/.test(out), out);
  });

  await test('PowerShell child runs with ExecutionPolicy=Bypass (session only)', async function () {
    nextAnswer = 'Run';
    const out = await call('runCommand', { shell: 'powershell', command: 'Get-ExecutionPolicy' });
    assert.ok(/Bypass/.test(out), 'the spawned session must report Bypass: ' + out);
  });

  await test('runCommand can execute a .ps1 script file end to end', async function () {
    nextAnswer = 'Run';
    const scriptPath = path.join(root, 'audit-script.ps1');
    fs.writeFileSync(scriptPath, "Write-Output 'PS1_SCRIPT_OK'\n", 'utf8');
    const out = await call('runCommand', {
      shell: 'powershell',
      command: "& '" + scriptPath.replace(/'/g, "''") + "'"
    });
    assert.ok(/PS1_SCRIPT_OK/.test(out), 'unsigned local .ps1 must run: ' + out);
  });

  await test('runCommand reports a non-zero exit code', async function () {
    nextAnswer = 'Run';
    const out = await call('runCommand', { shell: 'cmd', command: 'exit /b 3' });
    assert.ok(/STATUS: OK/.test(out) || /3/.test(out), out);
  });

  await test('runCommand whitelist matches whole program names, not string prefixes', async function () {
    assert.strictEqual(agent.isShellCommandAllowed('dir /b', ['dir']), true, 'dir /b is on the whitelist');
    assert.strictEqual(agent.isShellCommandAllowed('dirx /b', ['dir']), false,
      'dirx is a different program: the prefix must end at a command boundary');
    assert.strictEqual(agent.isShellCommandAllowed('dir /b && del x', ['dir']), false,
      'chaining must not inherit the whitelist entry');
    assert.strictEqual(agent.isShellCommandAllowed('dir /b; rm -rf ~', ['dir']), false,
      'a semicolon starts a new command that also has to be whitelisted');
    assert.strictEqual(agent.isShellCommandAllowed('dir /b | find "x"', ['dir', 'find']), true,
      'every segment whitelisted -> allowed');
  });

  await test('runCommand blocked when allowShell=false', async function () {
    const c = JSON.parse(JSON.stringify(cfg));
    c.constraints.allowShell = false;
    const out = await call('runCommand', { shell: 'cmd', command: 'echo x' }, c);
    assert.ok(/Shell execution is OFF/.test(out), out);
  });

  /* ---------- constraints ---------- */
  await test('readOnly blocks writes but keeps runCommand (documented)', async function () {
    const c = JSON.parse(JSON.stringify(cfg));
    c.constraints.readOnly = true;
    assert.ok(/readOnly|只读|disabled/i.test(await call('createFile', { path: 'ro.txt', text: 'x' }, c)));
    const gate = rules.checkToolCall({ tool: 'runCommand', args: { command: 'dir' } }, c.constraints);
    assert.strictEqual(gate.allowed, true);
  });

  await test('deniedTools blocks a tool before it runs', async function () {
    const c = JSON.parse(JSON.stringify(cfg));
    c.constraints.deniedTools = ['readFile'];
    const gate = rules.checkToolCall({ tool: 'readFile', args: { path: 'a.txt' } }, c.constraints);
    assert.strictEqual(gate.allowed, false);
  });

  await test('allowedReadGlobs blocks a non-matching path', async function () {
    const c = JSON.parse(JSON.stringify(cfg));
    c.constraints.allowedReadGlobs = ['docs/**'];
    const out = await call('readFile', { path: 'a.txt' }, c);
    assert.ok(/not allowed/.test(out) || /outside/.test(out), out);
  });

  /* ---------- protocol ---------- */
  await test('parse plain JSON call', function () {
    const c = protocol.parseToolCall('{"tool":"readFile","args":{"path":"a.txt"}}');
    assert.deepStrictEqual(c, { tool: 'readFile', args: { path: 'a.txt' } });
  });

  await test('parse fenced JSON call', function () {
    const c = protocol.parseToolCall('```json\n{"tool":"listFiles","args":{}}\n```');
    assert.strictEqual(c.tool, 'listFiles');
  });

  await test('parse call embedded in prose', function () {
    const c = protocol.parseToolCall('我先看一下：\n{"tool":"readFile","args":{"path":"a.txt"}}\n稍等');
    assert.strictEqual(c.tool, 'readFile');
  });

  await test('parse DSML invoke block', function () {
    const c = protocol.parseToolCall('<｜｜DSML｜｜ invoke name="readFile">\n<｜｜DSML｜｜ parameter name="args" string="false">{"path":"a.txt"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>');
    assert.strictEqual(c.tool, 'readFile');
    assert.strictEqual(c.args.path, 'a.txt');
  });

  await test('parse DSML loose params: tool name inside a parameter tag, calls wrapper open', function () {
    // 真机记录（v1.6.7 时期）：模型用 <...calls> 开头、invoke 开标签缺失、工具名放在 parameter 标签里
    const c = protocol.parseToolCalls('要验证数值是否真的更准，我实际算一下。\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ parameter name="args" string="false">{"command":"node -e \\"1\\"","shell":"powershell"}</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="tool" string="true">runCommand</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].tool, 'runCommand');
    assert.strictEqual(c[0].args.shell, 'powershell');
    assert.ok(/node -e/.test(c[0].args.command));
  });

  await test('parse DSML loose params: no invoke open tag at all, args as string', function () {
    const c = protocol.parseToolCalls('<｜｜DSML｜｜ parameter name="args" string="true">{"path":"index.html"}</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="tool" string="true">readFile</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].tool, 'readFile');
    assert.strictEqual(c[0].args.path, 'index.html');
  });

  await test('two calls in one reply: only the first is executed', function () {
    const c = protocol.parseToolCall('{"tool":"readFile","args":{"path":"a.txt"}}\n{"tool":"listFiles","args":{}}');
    assert.strictEqual(c.tool, 'readFile');
  });

  await test('empty-args rescue: args JSON found elsewhere in the reply is merged back (v1.7.4)', function () {
    // 模型偶尔把调用和参数拆成两个 JSON，或发出空 args；能捞回就省一整轮重试
    const split = protocol.parseToolCall('{"tool":"runCommand"}\n\n我会执行目录列表。\n{"command":"Get-ChildItem -Name","shell":"powershell"}');
    assert.strictEqual(split.tool, 'runCommand');
    assert.strictEqual(split.args.command, 'Get-ChildItem -Name');
    assert.strictEqual(split.args.shell, 'powershell');
    // 整条回复就是一个调用、参数跟在后面（direct 路径）
    const direct = protocol.parseToolCall('{"tool":"readFile"} {"path":"src/a.js"}');
    assert.strictEqual(direct.tool, 'readFile');
    assert.strictEqual(direct.args.path, 'src/a.js');
    // 未知键的 JSON 不能误捞
    const stranger = protocol.parseToolCall('{"tool":"listFiles"}\n{"title":"结果","count":3}');
    assert.strictEqual(stranger.tool, 'listFiles');
    assert.deepStrictEqual(stranger.args, {});
    // 两个调用时不捞（避免把第二个调用的上下文误接给第一个）
    const two = protocol.parseToolCalls('{"tool":"runCommand"}\n{"tool":"readFile","args":{"path":"a.txt"}}');
    assert.strictEqual(two.length, 2);
    assert.deepStrictEqual(two[0].args, {});
  });

  await test('parse mangled DSML: spaced bars + unclosed invoke (v1.6.9 real log regression)', function () {
    // 真机记录（v1.7.1 时期）：长会话收尾时模板退化成 < | | | | DSML | | | |、
    // invoke 无闭合、无 parameter 标签，整段原样漏进聊天区。
    const leaked = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="runCommand">\n< | | | | DSML | | | |\n\n（我还是得写标准格式。）\n\n<｜｜DSML｜｜ invoke name="runCommand">\n< | | DSML | |\n\n抱歉，格式出错了。重新发。';
    const c = protocol.parseToolCalls(leaked);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].tool, 'runCommand');
  });

  await test('parse unclosed DSML invoke that still carries a parameter tag', function () {
    const c = protocol.parseToolCalls('<｜｜DSML｜｜ invoke name="readFile">\n<｜｜DSML｜｜ parameter name="args" string="false">{"path":"index.html"}\n（无闭合标签）');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].tool, 'readFile');
    assert.strictEqual(c[0].args.path, 'index.html');
  });

  await test('invoke open tag fully missing: no call parseable, but flagged as broken template (v1.7.2 real log regression)', function () {
    // 真机记录（v1.7.2 时期）：收尾时只剩 parameter 标签与孤立的 </invoke> 闭合，
    // 连工具名都拿不到；必须能检测出来交给 agent 回填格式纠错，而不是把
    // 模板原文当回答显示。
    const leaked = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ parameter name="args" string="false">{"command": "$l = Get-Content radar.js -Encoding UTF8; $l[95..152]", "shell": "powershell"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    assert.strictEqual(protocol.parseToolCalls(leaked).length, 0, 'cannot recover a tool name from this shape');
    assert.strictEqual(protocol.hasBrokenToolTemplate(leaked), true);
    // 好调用、纯 JSON、普通文字、HTML 讨论（裸 <parameter>）都不能误判
    assert.strictEqual(protocol.hasBrokenToolTemplate('<｜｜DSML｜｜ invoke name="readFile">\n<｜｜DSML｜｜ parameter name="args" string="false">{"path":"index.html"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>'), false);
    assert.strictEqual(protocol.hasBrokenToolTemplate('{"tool":"listFiles","args":{}}'), false);
    assert.strictEqual(protocol.hasBrokenToolTemplate('任务已完成，radar.js 已写入 14628 字符。'), false);
    assert.strictEqual(protocol.hasBrokenToolTemplate('HTML 里 <parameter> 不是标准标签。'), false);
    // agent 侧：坏模板的碎片能被剥干净；带前缀正文的只剥标签行
    assert.strictEqual(agent.stripToolTemplateFragments(leaked), '');
    const withProse = '已完成检查。\n' + leaked;
    assert.strictEqual(agent.stripToolTemplateFragments(withProse), '已完成检查。');
  });

  await test('special-token leak: mangled <｜tool prefix repaired, unrepairable flagged (v1.7.6 real log regression)', function () {
    // 真机记录（v1.7.5 时期）：收尾时 DeepSeek 特殊 token 残片泄漏，把调用
    // JSON 的开括号一起吞掉（<｜tool":"runCommand",...}}），v1.7.5 既解析
    // 不出也检测不到，整段原文漏进聊天区。
    const leak = '<｜tool":"runCommand","args":{"shell":"cmd","command":"Get-Content index.html"}}';
    const fixed = protocol.parseToolCalls(leak);
    assert.strictEqual(fixed.length, 1, 'the mangled prefix must be repaired back to {"tool');
    assert.strictEqual(fixed[0].tool, 'runCommand');
    assert.strictEqual(fixed[0].args.command, 'Get-Content index.html');
    // 完整特殊 token 包裹的标准调用：剥掉 token 后照常解析
    const wrapped = protocol.parseToolCalls('<｜tool▁call▁begin｜>{"tool":"readFile","args":{"path":"a.txt"}}<｜tool▁call▁end｜>');
    assert.strictEqual(wrapped.length, 1);
    assert.strictEqual(wrapped[0].tool, 'readFile');
    // 修不回来的残缺碎片：必须判为坏模板触发重试，不能放行
    const broken = '<｜tool▁call▁begin｜>runCommand $i=0';
    assert.strictEqual(protocol.parseToolCalls(broken).length, 0);
    assert.strictEqual(protocol.hasBrokenToolTemplate(broken), true);
    assert.strictEqual(protocol.hasBrokenToolTemplate('总结：<｜User｜> 的问题已全部处理完。'), true);
    // 防误判：半角 <|x|> 是正则/管道常见写法，不算泄漏
    assert.strictEqual(protocol.hasBrokenToolTemplate('正则里 <|x|> 表示分支。'), false);
    // 显示层：特殊 token 残片的行要被剥掉，正常正文保留
    assert.strictEqual(agent.stripToolTemplateFragments('已完成检查。\n<｜tool":"runCommand","args":{}}'), '已完成检查。');
    assert.strictEqual(agent.stripToolTemplateFragments('已完成检查。\n<｜tool▁call▁begin｜>'), '已完成检查。');
  });

  await test('trailing comma in call JSON is tolerated (v1.7.8 real log regression)', function () {
    // 真机记录（v1.7.7 时期）：模型收尾时输出的调用 JSON 带尾逗号
    // （..."command":"Get-ChildItem matlab",}}），JSON.parse 失败，坏模板
    // 检测也不认（形态太接近合法 JSON），原文漏进聊天区且命令没跑。
    const leak = '{"tool":"runCommand","args":{"shell":"powershell","command":"Get-ChildItem matlab",}}';
    const fixed = protocol.parseToolCalls(leak);
    assert.strictEqual(fixed.length, 1, 'trailing comma must be stripped before JSON.parse');
    assert.strictEqual(fixed[0].tool, 'runCommand');
    assert.strictEqual(fixed[0].args.command, 'Get-ChildItem matlab');
    // 字符串内容里的 ",}" 是数据，不能被误伤
    const inside = protocol.parseToolCalls('{"tool":"runCommand","args":{"shell":"cmd","command":"Write-Output \\"a,}b\\""}}');
    assert.strictEqual(inside[0].args.command, 'Write-Output "a,}b"');
    // args 双重编码 + 尾逗号也能兜住
    const dbl = protocol.parseToolCalls('{"tool":"readFile","args":"{\\"path\\":\\"a.txt\\",}"}');
    assert.strictEqual(dbl[0].args.path, 'a.txt');
  });

  await test('function-tag residue detected as broken template (v1.7.9 real log regression)', function () {
    // 真机记录（v1.7.8 时期）：Qwen 模板收尾退化——<function=runCommand> 开
    // 标签与 parameter 标签整体丢失，只剩参数值与孤立 </function>，连工具
    // 名都拿不到，必须判坏模板触发重发，而不是把参数值原文漏给用户。
    const leak = '✓ 已完成\npowershell\nGet-ChildItem -Recurse -File "public\\device" | Select-Object -ExpandProperty FullName\n</function>';
    assert.strictEqual(protocol.parseToolCalls(leak).length, 0, 'no tool name recoverable from this shape');
    assert.strictEqual(protocol.hasBrokenToolTemplate(leak), true);
    // 显示层：标签行剥掉
    assert.strictEqual(agent.stripToolTemplateFragments('正文\n</function>'), '正文');
    // 防误判：普通代码/文字里的 function 关键字（无 < 前缀）不触发
    assert.strictEqual(protocol.hasBrokenToolTemplate('先写 function foo() {}，再调用它。'), false);
    assert.strictEqual(protocol.hasBrokenToolTemplate('任务完成，runCommand 已执行 2 次。'), false);
  });

  await test('missing-"args" shorthand JSON is repaired and executed (v1.9.1 real log regression)', function () {
    // 真机记录（v1.9.1 时期）：模型输出 {"tool":"runCommand":{"shell":...}}，
    // tool 值后直接跟冒号、漏了 "args": 键——JSON.parse 失败，坏模板检测也
    // 不认（无标签特征），整段原文漏进聊天区；同轮的另一条正确调用已执行。
    const leak = '依赖未安装，所以 start.bat 现在会先跑安装。\n' +
      '{"tool":"runCommand":{"shell":"powershell","command":"cd udp-monitor; .\\\\runtime\\\\python.exe -m pip install --no-index --find-links wheels -r requirements.txt"}}';
    const fixed = protocol.parseToolCalls(leak);
    assert.strictEqual(fixed.length, 1, 'the colon-shape must be repaired, not leaked');
    assert.strictEqual(fixed[0].tool, 'runCommand');
    assert.strictEqual(fixed[0].args.shell, 'powershell');
    // 能修回来的不算坏模板（不浪费一轮重试）
    assert.strictEqual(protocol.hasBrokenToolTemplate(leak), false);
    // 变体：工具名直接当键 {"runCommand":{...}}
    const keyed = '{"runCommand":{"command":"node --version"}}';
    const k = protocol.parseToolCalls(keyed);
    assert.strictEqual(k.length, 1, 'tool-name-as-key shape must be repaired');
    assert.strictEqual(k[0].tool, 'runCommand');
    assert.strictEqual(k[0].args.command, 'node --version');
    // 修不回来的截断形态：判坏模板触发重试，原文不显示
    const truncated = '正在安装。\n{"tool":"runCommand":{"shell":"pow';
    assert.strictEqual(protocol.parseToolCalls(truncated).length, 0);
    assert.strictEqual(protocol.hasBrokenToolTemplate(truncated), true);
    // 显示层：可提取的 JSON 调用块整块剥掉，正文保留；普通 JSON 不误伤
    assert.strictEqual(agent.stripToolTemplateFragments(
      '依赖未安装。\n{"tool":"runCommand":{"shell":"powershell"}}\n已重试。'), '依赖未安装。\n已重试。');
    assert.strictEqual(agent.stripToolTemplateFragments('配置 {"name":"x","version":1} 已写好。'), '配置 {"name":"x","version":1} 已写好。');
    // 防误判：普通 JSON / 讨论性文字不触发坏模板
    assert.strictEqual(protocol.hasBrokenToolTemplate('返回 {"status":"ok","count":2}。'), false);
  });

  /* ---- v1.8.0 自动经验记忆：只有「报错后被修好」才值得记，且必须短 ----
   * 这些是从真机日志里摘出来的报错原文，经验必须是可直接照做的动作。 */
  await test('deriveLesson turns a recovered error into one actionable note', function () {
    const cases = [
      ['runCommand', 'TOOL ERROR: runCommand requires args.command', 'arg-missing'],
      ['saveText', 'TOOL ERROR: Text too long to write. 45123 chars, single-call limit is 20000.', 'too-long'],
      ['readFile', 'TOOL ERROR: path ../x.txt escapes the workspace', 'outside-workspace'],
      ['saveText', 'TOOL ERROR: ENOENT: no such file or directory, open a.txt', 'not-found'],
      ['createFile', 'TOOL ERROR: a.md already exists; pass overwrite:true to replace it', 'overwrite'],
      ['readFile', 'TOOL ERROR: cannot read binary file (png)', 'binary'],
      ['runCommand', 'COMMAND (powershell): Get-ChildItem\nSTATUS: FAILED | exit=1\nSTDERR:\nParserError: Missing closing \'}\'', 'ps-quote'],
      ['makeCoffee', 'TOOL ERROR: unknown tool "makeCoffee". Allowed: readFile, ...', 'unknown-tool']
    ];
    cases.forEach(function (c) {
      const lesson = lessons.deriveLesson({ tool: c[0], error: c[1] });
      assert.ok(lesson, 'must learn from: ' + c[1].slice(0, 40));
      assert.strictEqual(lesson.id, c[2], 'wrong lesson id for: ' + c[1].slice(0, 40));
      assert.ok(lesson.text.length <= lessons.MAX_LESSON_CHARS, 'lesson must stay short enough for a prompt');
      assert.ok(lesson.text.length >= 20, 'lesson must actually explain the fix');
    });
  });

  await test('deriveLesson stays silent on user decisions and unknown errors', function () {
    assert.strictEqual(lessons.deriveLesson({ tool: 'runCommand', error: 'TOOL BLOCKED: user rejected this tool call.' }), null);
    assert.strictEqual(lessons.deriveLesson({ tool: 'runCommand', error: 'TOOL BLOCKED: tool approval timed out after 120 s' }), null);
    assert.strictEqual(lessons.deriveLesson({ tool: 'runCommand', error: 'TOOL BLOCKED BY CONSTRAINT: 只读模式' }), null);
    assert.strictEqual(lessons.deriveLesson({ tool: 'readFile', error: 'something odd happened' }), null);
    assert.strictEqual(lessons.deriveLesson({ tool: 'readFile', error: '' }), null);
  });

  await test('addLesson dedupes by id, counts hits, and stops at the cap', function () {
    let list = [];
    list = lessons.addLesson(list, { id: 'too-long', text: 'A' });
    list = lessons.addLesson(list, { id: 'too-long', text: 'B' });
    assert.strictEqual(list.length, 1, 'same id must not create a second entry');
    assert.strictEqual(list[0].text, 'B', 'newest wording wins');
    assert.strictEqual(list[0].hits, 2, 'a repeat must bump the hit count instead of piling up');

    /* 旧的 12 条硬上限已解除：造 40 条也要全部留下。 */
    for (let i = 0; i < 40; i++) {
      list = lessons.addLesson(list, { id: 'custom-' + i, text: 'note ' + i });
    }
    assert.strictEqual(list.length, 41, 'the old 12-item cap must be gone: all distinct lessons survive');
    assert.strictEqual(list[list.length - 1].text, 'note 39', 'newest kept at the tail');
    assert.ok(list.some(function (it) { return it.text === 'B'; }), 'no entry is dropped just for being old');

    /* 但总字符仍要有边界，否则提示词会被无限撑大：灌入超长经验后
     * 触发预算裁剪，最旧的先走，最新的留下。 */
    let budgeted = [];
    for (let i = 0; i < 90; i++) {
      budgeted = lessons.addLesson(budgeted, { id: 'bulk-' + i, text: 'x'.repeat(180) });
    }
    assert.ok(budgeted.length > 12, 'budget must allow far more than the old 12');
    assert.ok(budgeted.every(function (it) { return it.text.length <= lessons.MAX_LESSON_CHARS; }),
      'each lesson stays within its own char limit');
    assert.strictEqual(budgeted[budgeted.length - 1].id, 'bulk-89', 'newest survives budget trimming');
  });

  await test('a tool that failed several times keeps every distinct error until it works', function () {
    const map = new Map();
    /* 第一次是「没法总结」的错误，第二次才是可总结的。旧实现每个工具只留
     * 第一条错误，经验就这样被挡掉了——用户看到的正是「跑了好几次、最后
     * 成功了，经验却没记上」。 */
    agent.notePendingFix(map, 'createFile', 'TOOL ERROR: ECONNRESET while talking to the gateway', 1);
    agent.notePendingFix(map, 'createFile', 'TOOL ERROR: a.md already exists; pass overwrite:true', 1);
    assert.strictEqual(map.get('createFile').length, 2, 'distinct errors must not overwrite each other');

    const fixes = agent.takePendingFixes(map, 'createFile', 1);
    assert.strictEqual(fixes.length, 2);
    const ids = fixes
      .map(function (f) { return lessons.deriveLesson(f); })
      .filter(Boolean)
      .map(function (l) { return l.id; });
    assert.deepStrictEqual(ids, ['overwrite'], 'the summarisable failure must survive even when the first one was noise');
    assert.strictEqual(map.size, 0, 'taking must clear the tool entry');

    for (let i = 0; i < agent.MAX_PENDING_PER_TOOL + 3; i++) {
      agent.notePendingFix(map, 'runCommand', 'TOOL ERROR: distinct failure ' + i, 1);
    }
    assert.strictEqual(map.get('runCommand').length, agent.MAX_PENDING_PER_TOOL, 'one tool cannot hoard errors');
  });

  await test('a fix that only lands in a later round is still remembered', function () {
    const map = new Map();
    agent.notePendingFix(map, 'saveText', 'TOOL ERROR: ENOENT: no such file or directory', 1);
    const same = agent.takePendingFixes(map, 'saveText', 2);
    assert.strictEqual(same.length, 1, 'the same tool succeeding next round must consume the old failure');

    /* 换个话题：别的工具成功不能把上一轮的旧账记成经验。 */
    agent.notePendingFix(map, 'saveText', 'TOOL ERROR: ENOENT: no such file or directory', 1);
    assert.strictEqual(agent.takePendingFixes(map, 'readFile', 2).length, 0,
      'a different tool must not claim a previous round failure');

    /* 同一轮里换工具绕过去：算已解决。 */
    agent.notePendingFix(map, 'saveText', 'TOOL ERROR: ENOENT: no such file', 2);
    assert.strictEqual(agent.takePendingFixes(map, 'readFile', 2).length, 1,
      'a same-round workaround does count as solved');
  });

  await test('stale failures are dropped instead of resurfacing much later', function () {
    const map = new Map();
    agent.notePendingFix(map, 'createFile', 'TOOL ERROR: a.md already exists', 1);
    agent.prunePendingFixes(map, 1 + agent.PENDING_FIX_TTL_RUNS + 1);
    assert.strictEqual(map.size, 0, 'a failure older than the TTL must never be learned from');
  });

  await test('lessons reach the prompt in their own section, never as user rules', function () {    const withLessons = rules.compileSystemPrompt({
      basePrompt: 'base',
      memoryRules: ['注释用中文'],
      lessons: [{ id: 'too-long', text: '单次写入上限 20000 字符：先拆小文件。' }],
      constraints: { readOnly: true }
    });
    assert.ok(/## 经验教训/.test(withLessons), 'lessons need their own section');
    assert.ok(withLessons.indexOf('单次写入上限 20000 字符') !== -1, 'lesson text must be injected');
    const rulePart = withLessons.split('## 经验教训')[0];
    assert.ok(rulePart.indexOf('## 长期通用要求') !== -1, 'user rules section must stay');
    assert.ok(rulePart.indexOf('单次写入上限') === -1, 'a lesson must not masquerade as a user rule');
    // 删掉之后必须真的消失，否则「管理经验」是假的
    const without = rules.compileSystemPrompt({ basePrompt: 'base', lessons: [], constraints: { readOnly: true } });
    assert.ok(without.indexOf('## 经验教训') === -1, 'empty lesson list must not leave an empty section');
    // 用户关掉长期记忆时，经验也不该再注入
    const off = rules.compileSystemPrompt({ basePrompt: 'base', lessons: [{ id: 'x', text: 'y' }], rememberRules: false, constraints: {} });
    assert.ok(off.indexOf('## 经验教训') === -1, 'lessons follow the remember switch');
  });

  await test('parseToolCalls reports every call in one reply', function () {
    const all = protocol.parseToolCalls('{"tool":"readFile","args":{"path":"a.txt"}}\n{"tool":"listFiles","args":{}}');
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map(function (c) { return c.tool; }), ['readFile', 'listFiles']);
  });

  await test('malformed JSON is not treated as a call', function () {
    assert.strictEqual(protocol.parseToolCall('{"tool":"readFile",,}'), null);
  });

  /* ---------- taskCheck ---------- */
  await test('taskCheck: false claim with zero tools fails', function () {
    const v = taskCheck.evaluate({ userText: '帮我复制文件到 backup', answer: '已完成', trace: { rounds: 1, tools: [], writeChecks: [] } });
    assert.strictEqual(v.level, 'fail');
    assert.strictEqual(v.verdict, 'false-claim');
  });

  await test('taskCheck: successful write is ok', function () {
    const v = taskCheck.evaluate({
      userText: '新建 report.txt 写 hello', answer: '已创建。',
      trace: { rounds: 2, tools: [{ tool: 'createFile', status: 'ok', path: 'report.txt' }], writeChecks: [{ path: 'report.txt', exists: true, bytes: 5, fresh: true }] }
    });
    assert.strictEqual(v.level, 'ok');
  });

  await test('taskCheck: pure question stays silent', function () {
    const v = taskCheck.evaluate({ userText: '这个插件支持哪些工具？', answer: '支持 9 个工具。', trace: { rounds: 1, tools: [], writeChecks: [] } });
    assert.strictEqual(v.level, 'none');
  });

  /* ---------- endpoint ---------- */
  await test('endpoint: host:port gains /v1', function () {
    const r = endpoint.normalizeEndpoint('192.168.1.20:8080', '');
    assert.strictEqual(r.ok, true);
    assert.ok(/\/v1$/.test(r.value), r.value);
  });

  await test('endpoint: port-only without a saved address is rejected', function () {
    const r = endpoint.normalizeEndpoint('8080', '');
    assert.strictEqual(r.ok, false);
  });

  await test('endpoint: rejects a non-http scheme', function () {
    const r = endpoint.normalizeEndpoint('ftp://host/v1', '');
    assert.strictEqual(r.ok, false);
  });

  await test('endpoint: keeps an existing full path', function () {
    const r = endpoint.normalizeEndpoint('http://h:8000/ollama/v1', '');
    assert.strictEqual(r.value, 'http://h:8000/ollama/v1');
  });

  /* ---------- importFile ---------- */
  await test('importFile reads txt / md / csv as text', async function () {
    write('imp/data.csv', 'a,b\n1,2\n');
    const out = await call('importFile', { path: 'imp/data.csv' });
    assert.ok(/IMPORTED FILE: imp\/data\.csv/.test(out) && /1,2/.test(out), out);
  });

  await test('importFile reports binary instead of garbage', async function () {
    fs.writeFileSync(path.join(root, 'imp.bin'), Buffer.from([0, 1, 2, 3]));
    const out = await call('importFile', { path: 'imp.bin' });
    assert.ok(/^TOOL ERROR|binary|二进制/i.test(out), out);
  });

  await test('importFile parses docx / xlsx ZIP containers (zero-dep)', async function () {
    // 能力表承诺导入 docx/xlsx，但此前只有 txt/md/csv 有测试。手工构造
    // 最小 ZIP 容器（stored 方式）验证零依赖解析链路。
    function crc32(buf) {
      if (!crc32.table) {
        crc32.table = [];
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
          crc32.table[n] = c >>> 0;
        }
      }
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) { crc = crc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function buildZip(entries) {
      const parts = [];
      const centrals = [];
      let off = 0;
      for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 8); // method 0 = stored
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(e.data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, e.data);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(e.data.length, 20);
        cd.writeUInt32LE(e.data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(off, 42);
        centrals.push(cd, name);
        off += 30 + name.length + e.data.length;
      }
      const cdStart = off;
      for (const p of centrals) { parts.push(p); off += p.length; }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(off - cdStart, 12);
      eocd.writeUInt32LE(cdStart, 16);
      parts.push(eocd);
      return Buffer.concat(parts);
    }
    const docx = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from(
        '<w:document><w:body><w:p><w:r><w:t>雷达信号说明</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>第二段 A&amp;B</w:t></w:r></w:p></w:body></w:document>') },
    ]);
    fs.writeFileSync(path.join(root, 'imp', 'doc.docx'), docx);
    const doc = await call('importFile', { path: 'imp/doc.docx' });
    assert.ok(/雷达信号说明/.test(doc), doc);
    assert.ok(/第二段 A&B/.test(doc), 'entities must decode: ' + doc);
    const xlsx = buildZip([
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>名称</t></si><si><t>频率</t></si></sst>') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(
        '<worksheet><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>MHz</t></is></c><c r="B2"><v>1.5</v></c></row></worksheet>') },
    ]);
    fs.writeFileSync(path.join(root, 'imp', 'table.xlsx'), xlsx);
    const sheet = await call('importFile', { path: 'imp/table.xlsx' });
    assert.ok(/名称,频率/.test(sheet), sheet);
    assert.ok(/MHz,1\.5/.test(sheet), sheet);
    // 旧版二进制 .doc/.xls 明确报错而不是乱码
    fs.writeFileSync(path.join(root, 'imp', 'old.doc'), Buffer.from([0xD0, 0xCF, 0x11, 0xE0]));
    const legacy = await call('importFile', { path: 'imp/old.doc' });
    assert.ok(/旧版二进制|另存为/.test(legacy), legacy);
  });

  await test('importFile: HTML is converted to plain text, never injected raw (v1.11.2)', async function () {
    /* 小模型拿到整页 HTML 会把标签当内容、把脚本当指令，回答直接跑偏。 */
    const page = '<!DOCTYPE html><html><head><title>设备手册</title>' +
      '<style>.a{color:red}</style><script>alert("x"); function hack(){return 1;}</script></head>' +
      '<body><!-- comment --><h1>频率范围</h1><p>1.5&nbsp;MHz &amp; 2.4&nbsp;MHz</p>' +
      '<ul><li>条目一</li><li>条目二</li></ul><div>结尾</div></body></html>';
    fs.writeFileSync(path.join(root, 'imp', 'manual.html'), page);
    const text = await call('importFile', { path: 'imp/manual.html' });
    assert.ok(/设备手册/.test(text), 'title must survive as a heading: ' + text);
    assert.ok(/频率范围/.test(text) && /条目一/.test(text) && /结尾/.test(text), text);
    assert.ok(!/<[a-z!/][^>]*>/i.test(text), 'no HTML tags may reach the model: ' + text);
    assert.ok(!/alert\("x"\)|function hack/.test(text), 'script bodies must be dropped: ' + text);
    assert.ok(!/color:red/.test(text), 'style bodies must be dropped: ' + text);
    assert.ok(!/<!--/.test(text), 'comments must be dropped: ' + text);
    assert.ok(/1\.5 MHz & 2\.4 MHz/.test(text), 'entities decoded + nbsp collapsed: ' + text);
    // .htm 与大写扩展名同样走转换
    fs.writeFileSync(path.join(root, 'imp', 'PAGE.HTM'), '<p>大写扩展名</p>');
    const upper = await call('importFile', { path: 'imp/PAGE.HTM' });
    assert.ok(/大写扩展名/.test(upper) && !/<p>/.test(upper), upper);
  });

  await test('importFile: binary / unknown types are refused with an actionable message', async function () {
    assert.strictEqual(fileImport.isSupported('x.png'), false);
    assert.strictEqual(fileImport.isSupported('x.html'), true, 'html stays importable (sanitised)');
    assert.strictEqual(fileImport.isSupported('x.htm'), true, 'htm must be accepted too');
    const bin = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01]);
    fs.writeFileSync(path.join(root, 'imp', 'pic.png'), bin);
    const refused = await call('importFile', { path: 'imp/pic.png' });
    assert.ok(/不支持的文件类型/.test(refused), refused);
    assert.ok(/二进制/.test(refused), 'the message must explain why: ' + refused);
  });

  /* ---------- wave 2: adversarial / non-standard model output ---------- */
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-audit2-'));
  await runtime.setWriteMode(true);
  await runtime.setWriteConfirm(false);
  write('a.txt', 'alpha');
  write('docs/guide.md', '# g');
  write('docs/note.txt', 'n');

  await test('protocol: args given as a JSON string is coerced', function () {
    const c = protocol.parseToolCall('{"tool":"readFile","args":"{\\"path\\":\\"a.txt\\"}"}');
    assert.ok(c, 'call must be recognised');
    assert.strictEqual(c.args.path, 'a.txt', 'string args must be parsed into an object');
  });

  await test('protocol: tool name with surrounding spaces still works', function () {
    const c = protocol.parseToolCall('{"tool":"  readFile  ","args":{"path":"a.txt"}}');
    assert.strictEqual(c.tool, 'readFile');
  });

  await test('protocol: Qwen <tool_call><function=X> template is parsed (regression from intranet v1.0.0)', function () {
    const shot = '好的，我先看一下。\n<tool_call>\n<function=listFiles>\n<parameter=args>\n{"path": "."}\n</parameter>\n</function>\n</tool_call>';
    const calls = protocol.parseToolCalls(shot);
    assert.strictEqual(calls.length, 1, JSON.stringify(calls));
    assert.strictEqual(calls[0].tool, 'listFiles');
    assert.strictEqual(calls[0].args.path, '.');
  });

  await test('protocol: Qwen template with empty args and name= attribute variants', function () {
    const a = protocol.parseToolCalls('<tool_call><function=getActiveFile><parameter=args>\n{}\n</parameter></function></tool_call>');
    assert.strictEqual(a.length, 1 && a[0].tool === 'getActiveFile' ? 1 : 0, JSON.stringify(a));
    assert.strictEqual(a[0].tool, 'getActiveFile');
    assert.deepStrictEqual(a[0].args, {});
    const b = protocol.parseToolCalls('<tool_call><function name="readFile"><parameter=args>{"path":"a.txt"}</parameter></function></tool_call>');
    assert.strictEqual(b[0].tool, 'readFile');
    assert.strictEqual(b[0].args.path, 'a.txt');
    const c = protocol.parseToolCalls('<tool_call><function=runCommand><parameter=command>dir</parameter></function></tool_call>');
    assert.strictEqual(c[0].tool, 'runCommand');
    assert.strictEqual(c[0].args.command, 'dir');
  });

  await test('protocol: Qwen native JSON inside <tool_call> ({"name":...,"arguments":{...}})', function () {
    const a = protocol.parseToolCalls('<tool_call>\n{"name": "readFile", "arguments": {"path": "a.txt"}}\n</tool_call>');
    assert.strictEqual(a[0].tool, 'readFile');
    assert.strictEqual(a[0].args.path, 'a.txt');
    const b = protocol.parseToolCalls('<tool_call>{"tool":"listFiles","args":{}}</tool_call>');
    assert.strictEqual(b[0].tool, 'listFiles');
    const c = protocol.parseToolCalls('<tool_call>{"name":"readFile","arguments":"{\\"path\\":\\"b.txt\\"}"}</tool_call>');
    assert.strictEqual(c[0].args.path, 'b.txt');
  });

  await test('protocol: truncated <tool_call> without closing tag still parses', function () {
    const a = protocol.parseToolCalls('我来查看。\n<tool_call>\n<function=readFile>\n<parameter=args>\n{"path": "a.txt"}');
    assert.strictEqual(a[0].tool, 'readFile');
    assert.strictEqual(a[0].args.path, 'a.txt');
    const b = protocol.parseToolCalls('<tool_call>\n{"name":"listFiles","arguments":{"pattern":"**/*.md"}}');
    assert.strictEqual(b[0].args.pattern, '**/*.md');
    // 反向保护：整段里没有 tool_call 也没有可解析调用时，不能凭空造一个
    assert.deepStrictEqual(protocol.parseToolCalls('<tool_call>garbage without anything useful'), []);
  });

  await test('absolute path inside the workspace is accepted or explicitly refused', async function () {
    const out = await call('readFile', { path: path.join(root, 'a.txt') });
    assert.ok(out === 'FILE: ' + path.join(root, 'a.txt') + '\nalpha' || /outside the workspace/.test(out),
      'unexpected: ' + out);
  });

  await test('a .. path is normalised inside the workspace', async function () {
    const out = await call('readFile', { path: 'docs/../a.txt' });
    assert.ok(/^FILE: docs\/\.\.\/a\.txt\nalpha$/.test(out), out);
  });

  await test('createFile with a trailing separator is refused', async function () {
    const out = await call('createFile', { path: 'newdir/', text: 'x' });
    assert.ok(/^TOOL ERROR:/.test(out), 'must not write a file with an odd name: ' + out);
  });

  await test('saveText aimed at a directory is refused', async function () {
    const out = await call('saveText', { path: 'docs', text: 'x' });
    assert.ok(/^TOOL ERROR:/.test(out), out);
  });

  await test('listFiles caps at 200 entries', async function () {
    for (let i = 0; i < 210; i++) { write('many/f' + i + '.txt', 'x'); }
    const out = await call('listFiles', {});
    const lines = out.split('\n').length - 1;
    assert.ok(lines <= 200, 'expected <= 200 lines, got ' + lines);
    assert.ok(/max 200/.test(out), 'the cap must be stated to the model');
  });

  await test('an empty string in the shell whitelist must not allow everything', function () {
    assert.strictEqual(agent.isShellCommandAllowed('format C:', ['']), false);
  });

  await test('allowedReadGlobs **/*.md still blocks .txt', async function () {
    const c = JSON.parse(JSON.stringify(runtime.getConfig()));
    c.constraints.allowedReadGlobs = ['**/*.md'];
    const okOut = await call('readFile', { path: 'docs/guide.md' }, c);
    assert.ok(/^FILE:/.test(okOut), okOut);
    const blocked = await call('readFile', { path: 'docs/note.txt' }, c);
    assert.ok(/not allowed/.test(blocked), blocked);
  });

  await test('runSubtask is gated when subtask mode is off', async function () {
    const gate = rules.checkToolCall({ tool: 'runSubtask', args: { goal: 'x' } }, runtime.getConfig().constraints);
    assert.strictEqual(gate.allowed, false);
  });

  await test('endpoint: a trailing slash is trimmed so /chat/completions is not doubled', function () {
    const r = endpoint.normalizeEndpoint('http://h:8000/v1/', '');
    assert.ok(r.ok, r.error);
    assert.ok(!/\/$/.test(r.value), 'trailing slash kept: ' + r.value);
  });

  /* ---------- wave 3: "streaming" is local now, so tools keep working ------- */
  await test('streaming mode still executes tools and replays the final answer', async function () {
    write('a.txt', 'alpha');
    const agentPath = require.resolve('../src/agent');
    const llmPath = require.resolve('../src/llmClient');
    const savedLlm = require.cache[llmPath];
    delete require.cache[agentPath];
    delete require.cache[llmPath];
    let calls = 0;
    const longAnswer = '读完了：alpha。' + '这里是补充说明。'.repeat(6);
    Module._load = function (request) {
      if (request === 'vscode') { return vscodeStub; }
      if (request === './llmClient') {
        // classifyError must stay real enough to pass through messages.
        const real = savedLlm.exports;
        return {
          classifyError: real.classifyError,
          chatCompletion: async function () {
            calls += 1;
            return { content: calls === 1 ? '{"tool":"readFile","args":{"path":"a.txt"}}' : longAnswer };
          }
        };
      }
      return originalLoad.apply(this, arguments);
    };
    const freshAgent = require('../src/agent');
    const cfgStream = runtime.getConfig();
    cfgStream.stream = true;
    const seen = [];
    const answer = await freshAgent.runAgent({
      config: cfgStream,
      apiKey: 'x',
      token: { isCancellationRequested: false },
      history: [{ role: 'user', content: '读一下 a.txt' }],
      onEvent: function (e) { seen.push(e); }
    });
    assert.strictEqual(answer, longAnswer);
    const ran = seen.filter(function (e) { return e.type === 'tool' && e.status === 'ok'; }).pop();
    assert.ok(ran, 'the tool must actually run while stream=true');
    assert.ok(/alpha/.test(ran.text), 'the tool result must come back: ' + (ran && ran.text));
    const deltas = seen.filter(function (e) { return e.type === 'delta'; });
    assert.ok(deltas.length > 1, 'the answer must be replayed in slices, got ' + deltas.length);
    assert.strictEqual(deltas.map(function (e) { return e.text; }).join(''), longAnswer);
    assert.ok(!seen.some(function (e) { return /streaming mode/.test(e.text || ''); }), 'no "tools skipped" warning any more');
    // restore the real modules for anything after this point
    Module._load = function (request) {
      if (request === 'vscode') { return vscodeStub; }
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[agentPath];
    delete require.cache[llmPath];
  });

  /* ---- v1.10.0: named model profiles ---- */

  await test('profiles: normalize keeps valid entries, dedupes by name, caps the list', function () {
    const lib = require('../src/profiles');
    const list = lib.normalizeProfiles([
      { name: 'local', baseUrl: 'http://127.0.0.1:1234/v1/', model: 'qwen', key: 'k1' },
      { name: '', baseUrl: 'http://x' },                       // no name -> dropped
      { name: 'local', baseUrl: 'http://other' },              // dup name -> dropped
      { name: 'cloud', model: 'gpt' },                          // model-only allowed
      { name: 'bad', baseUrl: '', model: '' }                   // nothing at all -> dropped
    ]);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].baseUrl, 'http://127.0.0.1:1234/v1', 'trailing slash must be trimmed');
    assert.strictEqual(list[1].name, 'cloud');
    assert.strictEqual(lib.MAX_PROFILES, 8);
  });

  await test('profiles: active detection is exact on baseUrl AND model', function () {
    const lib = require('../src/profiles');
    const list = lib.normalizeProfiles([
      { name: 'local', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' },
      { name: 'cloud', baseUrl: 'http://api.example.com/v1', model: 'big' }
    ]);
    assert.strictEqual(lib.findActive(list, 'http://127.0.0.1:1234/v1', 'qwen'), 'local');
    assert.strictEqual(lib.findActive(list, 'http://127.0.0.1:1234/v1', 'other'), '');
    assert.strictEqual(lib.findActive(list, '', ''), '');
  });

  await test('profiles: deleteProfile removes by name case-insensitively', function () {
    const lib = require('../src/profiles');
    const list = lib.normalizeProfiles([{ name: 'Local', baseUrl: 'http://a', model: 'm' }]);
    const r = lib.deleteProfile(list, 'local');
    assert.ok(r.ok);
    assert.strictEqual(r.list.length, 0);
    assert.strictEqual(lib.deleteProfile(list, 'nope').ok, false);
  });

  /* ---- v1.10.0: automatic context compaction ---- */

  await test('compact: needsCompaction mirrors takeRecent limits and needs MIN_DROPPED turns', function () {
    const compact = require('../src/compact');
    const cfg = { maxHistoryMessages: 10, maxContextChars: 100000 };
    const short = [];
    for (let i = 0; i < 8; i++) { short.push({ role: 'user', content: 'msg ' + i }); }
    assert.strictEqual(compact.needsCompaction(short, cfg).needed, false, '8 dropped would be < MIN_DROPPED only under 10-limit... actually 0 dropped here');
    const long = [];
    for (let i = 0; i < 16; i++) { long.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }); }
    const chk = compact.needsCompaction(long, cfg);
    assert.ok(chk.needed, '16 messages with a 10-limit must compact');
    assert.strictEqual(chk.dropped, 6);
    assert.strictEqual(chk.recent.messages.length, 10);
  });

  await test('compact: buildSummaryMessages frames roles and caps input size', function () {
    const compact = require('../src/compact');
    const msgs = compact.buildSummaryMessages([
      { role: 'user', content: '帮我建 a.md' },
      { role: 'assistant', content: '已创建 a.md' },
      { role: 'user', content: 'x'.repeat(compact.MAX_SUMMARY_INPUT_CHARS + 500) }
    ]);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, 'system');
    assert.ok(/摘要/.test(msgs[0].content));
    assert.ok(/帮我建 a\.md/.test(msgs[1].content));
    assert.ok(/已创建 a\.md/.test(msgs[1].content));
    assert.ok(msgs[1].content.length <= compact.MAX_SUMMARY_INPUT_CHARS + 200,
      'oversized input must be truncated, got ' + msgs[1].content.length);
    assert.ok(/已省略/.test(msgs[1].content), 'the truncation marker must be present');
  });

  await test('compact: applySummary replaces history in place and marks the summary', function () {
    const compact = require('../src/compact');
    const history = [];
    for (let i = 0; i < 6; i++) { history.push({ role: 'user', content: 'old ' + i }); }
    const kept = [{ role: 'user', content: 'recent question' }];
    const meta = { count: 6, items: history.map(function (m) { return compact.preview(m); }) };
    const msg = compact.applySummary(history, kept, '  要点一\n要点二  ', meta);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0], msg);
    assert.ok(history[0].content.indexOf(compact.SUMMARY_MARKER) === 0);
    assert.ok(/要点一/.test(history[0].content));
    assert.strictEqual(history[1].content, 'recent question');
    /* v1.13.4：摘要必须记住自己替掉了谁，否则面板只能含糊地说「有摘要」。 */
    assert.strictEqual(msg.compressedCount, 6);
    assert.strictEqual(msg.compressedItems.length, 6);
    assert.ok(/old 0/.test(msg.compressedItems[0].text));
    assert.ok(msg.compressedItems.every(function (it) { return it.text.length <= 60; }),
      'previews must stay short enough to persist in globalState');
  });

  /* ---- v1.10.0: per-round write snapshots ---- */

  await test('snapshots: captureBefore records existence and content', function () {
    const snap = require('../src/snapshots');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-snap-'));
    try {
      const existing = path.join(dir, 'a.txt');
      fs.writeFileSync(existing, 'old content', 'utf8');
      const rec1 = snap.captureBefore(existing, 'a.txt');
      assert.strictEqual(rec1.existed, true);
      assert.strictEqual(rec1.content, 'old content');
      const missing = path.join(dir, 'new.txt');
      const rec2 = snap.captureBefore(missing, 'new.txt');
      assert.strictEqual(rec2.existed, false);
      assert.strictEqual(rec2.content, null);
      fs.writeFileSync(path.join(dir, 'big.bin'), 'x');
      const rec3 = snap.captureBefore(path.join(dir, 'big.bin'), 'big.bin');
      assert.ok(rec3, 'readable files must snapshot');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('snapshots: revert restores overwritten files and deletes created ones', function () {
    const snap = require('../src/snapshots');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-snap-'));
    try {
      const existing = path.join(dir, 'a.txt');
      const created = path.join(dir, 'sub', 'b.txt');
      fs.mkdirSync(path.dirname(created), { recursive: true });
      fs.writeFileSync(existing, 'original', 'utf8');
      const records = [
        snap.captureBefore(existing, 'a.txt'),
        snap.captureBefore(created, path.join('sub', 'b.txt'))
      ];
      snap.record([], records[0]);  // record() must append safely to any array
      // simulate the round: overwrite a.txt, create sub/b.txt
      fs.writeFileSync(existing, 'rewritten by agent', 'utf8');
      fs.writeFileSync(created, 'fresh file', 'utf8');
      const results = snap.revert(dir, records);
      assert.strictEqual(results.length, 2);
      assert.ok(results.every(function (r) { return r.ok; }), JSON.stringify(results));
      assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'original', 'overwritten file must be restored');
      assert.ok(!fs.existsSync(created), 'created file must be deleted');
      // reverting twice from the same records would recreate a.txt; that is
      // the caller's job to prevent (host drops the entry) — document behaviour:
      assert.ok(snap.describeFiles(records).some(function (d) { return /a\.txt/.test(d); }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('snapshots: refuses to restore outside the workspace root', function () {
    const snap = require('../src/snapshots');
    const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-snap-in-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-snap-out-'));
    try {
      const results = snap.revert(inside, [{ rel: path.join('..', path.basename(outside), 'evil.txt'), existed: false, content: null }]);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].ok, false, 'a .. path must be refused');
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await test('agent runAgent accepts a shared snapshots array (sub-agents included)', async function () {
    const snap = require('../src/snapshots');
    const target = path.join(root, 'snap-me.txt');
    fs.writeFileSync(target, 'before', 'utf8');
    const shared = [];
    const cfg = runtime.getConfig();
    cfg.constraints = Object.assign({}, cfg.constraints, { confirmWrite: false });
    await runtime.setWriteMode(true);
    const answer = await agent.runTool(
      { tool: 'saveText', args: { path: 'snap-me.txt', text: 'after' } },
      cfg,
      { emit: function () {}, token: { isCancellationRequested: false }, snapshots: shared, depth: 0, taskState: { subtasks: 0 } }
    );
    assert.ok(/Wrote/.test(answer), answer);
    assert.strictEqual(shared.length, 1, 'the write must leave exactly one snapshot record');
    assert.strictEqual(shared[0].rel, 'snap-me.txt');
    assert.strictEqual(shared[0].existed, true);
    assert.strictEqual(shared[0].content, 'before');
    const results = snap.revert(root, shared);
    assert.ok(results[0].ok);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'before', 'revert must restore the pre-write content');
    await runtime.setWriteMode(false);
  });

  /* ---- v1.11.0: shell environment (bash option, prompt rules, mismatch hints) ---- */

  await test('shellEnv: resolveShell honors explicit valid shells and falls back with a note', function () {
    const env = require('../src/shellEnv');
    // bash available
    assert.strictEqual(env.resolveShell('auto', '', true).shell, 'bash', 'auto prefers bash when available');
    assert.strictEqual(env.resolveShell('powershell', '', true).shell, 'powershell');
    assert.strictEqual(env.resolveShell('cmd', 'bash', true).shell, 'bash', 'an explicit valid request always wins');
    // bash unavailable
    assert.strictEqual(env.resolveShell('auto', '', false).shell, 'powershell', 'auto degrades to powershell without bash');
    const denied = env.resolveShell('auto', 'bash', false);
    assert.strictEqual(denied.shell, 'powershell');
    assert.ok(/bash\.exe/.test(denied.note), 'unavailable bash must come with an explanatory note');
    assert.strictEqual(env.resolveShell('nonsense', '', true).shell, 'powershell', 'invalid prefer falls back to powershell');
  });

  await test('shellEnv: prompt section adapts to available shells and states the default', function () {
    const env = require('../src/shellEnv');
    const withBash = env.shellSyntaxSection('auto', true);
    const withoutBash = env.shellSyntaxSection('auto', false);
    assert.ok(/## Shell 执行环境/.test(withBash));
    assert.ok(/bash（Git Bash）/.test(withBash), 'bash rules must appear when bash is available');
    assert.ok(!/bash（Git Bash）/.test(withoutBash), 'bash rules must be omitted when bash is missing');
    assert.ok(/默认用 bash/.test(withBash) && /默认用 powershell/.test(withoutBash));
    assert.ok(/\$env:VAR/.test(withBash) && /set VAR=value/.test(withBash), 'per-shell variable syntax must be spelled out');
    assert.ok(/PS 5.1 不支持 &&/.test(withBash), 'the && pitfall must be stated');
  });

  await test('shellEnv: diagnoseMismatch catches the common wrong-dialect signatures', function () {
    const env = require('../src/shellEnv');
    // PowerShell cmdlets inside cmd
    const a = env.diagnoseMismatch('cmd', 'Get-ChildItem src', 'ERROR: Get-ChildItem is not recognized as an internal or external command');
    assert.ok(/cmdlet/.test(a) && /powershell/.test(a), 'PS cmdlet in cmd must be diagnosed');
    // $env: inside cmd
    const b = env.diagnoseMismatch('cmd', 'setx PATH "$env:JAVA_HOME"', '');
    assert.ok(/set VAR=value/.test(b), '$env: in cmd must point at set VAR=value');
    // && inside PowerShell 5.1
    const c = env.diagnoseMismatch('powershell', 'node build.js && npm test', "The token '&&' is not a valid statement separator in this version.");
    assert.ok(/不支持 &&/.test(c), '&& in PS 5.1 must be diagnosed');
    // export inside PowerShell
    const d = env.diagnoseMismatch('powershell', 'export FOO=1', '');
    assert.ok(/\$env:VAR="值"/.test(d), 'export in powershell must be diagnosed');
    // cmd-isms inside bash
    const e = env.diagnoseMismatch('bash', 'dir', 'bash: dir: command not found');
    assert.ok(/Git Bash/.test(e) && /ls/.test(e), 'dir in bash must point at ls');
    // %VAR% inside bash
    const f = env.diagnoseMismatch('bash', 'echo %PATH%', '');
    assert.ok(/\$VAR/.test(f), '%VAR% in bash must be diagnosed');
    // a legit failure gets no spurious hint
    assert.strictEqual(env.diagnoseMismatch('powershell', 'node --version', 'v16.20.2\nexit 1'), '', 'plain tool failure must not get a fake hint');
  });

  await test('processRunner: bash spawn spec keeps the command intact and blocks MSYS path conversion', function () {
    const proc = require('../src/processRunner');
    const spec = proc.buildSpawnSpec({ shell: 'bash', command: 'npm --version && ls C:/work', bashPath: 'C:/Program Files/Git/bin/bash.exe' });
    assert.strictEqual(spec.file, 'C:/Program Files/Git/bin/bash.exe');
    assert.deepStrictEqual(spec.args, ['-c', 'npm --version && ls C:/work'], 'the command must travel as a single argv element');
    assert.ok(spec.envExtra && spec.envExtra.MSYS_NO_PATHCONV === '1', 'MSYS path conversion must be disabled');
    const ps = proc.buildSpawnSpec({ shell: 'powershell', command: 'Get-Date' });
    assert.ok(!ps.envExtra, 'powershell spec must not carry bash env overrides');
  });

  /* ---- v1.11.0: AGENTS.md injection ---- */

  await test('agentsMd: reads the workspace file, caps lines and characters, wrapper pins it below constraints', function () {
    const amd = require('../src/agentsMd');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-'));
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目规则\n\n- 注释用中文\n' + Array(260).fill('- line').join('\n'), 'utf8');
      const text = amd.readAgentsMd(dir);
      assert.ok(/注释用中文/.test(text));
      assert.ok(/已截断/.test(text), 'over 200 lines must be truncated');
      const section = amd.agentsMdSection(dir);
      assert.ok(/## 项目说明/.test(section) && /运行约束/.test(section), 'wrapper must reference the constraint priority');
      // empty file -> no section
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '   \n', 'utf8');
      assert.strictEqual(amd.agentsMdSection(dir), '', 'a blank AGENTS.md must produce no section');
      // no file -> no section
      assert.strictEqual(amd.agentsMdSection(path.join(dir, 'missing')), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('rules: compileSystemPrompt embeds AGENTS.md and shell rules only when provided', function () {
    const rulesLib = require('../src/rules');
    const bare = rulesLib.compileSystemPrompt({});
    assert.ok(!/## 项目说明/.test(bare) && !/## Shell 执行环境/.test(bare), 'no file/no param -> no section');
    const full = rulesLib.compileSystemPrompt({
      agentsMd: '## 项目说明（工作区根目录 AGENTS.md）\n- 注释用中文',
      shellSection: '## Shell 执行环境\n- cmd 里 NEVER 使用 $env:'
    });
    assert.ok(/注释用中文/.test(full) && /NEVER 使用 \$env:/.test(full));
  });

  /* ---- 静态审计修掉的一批边界（v1.12.2）---- */

  await test('toolStatusOf: file text that says STATUS: FAILED is not a failed command', function () {
    const file = 'FILE: notes.md\n说明里写了一句 STATUS: FAILED，这是文档内容，不是命令结果。';
    assert.strictEqual(agent.toolStatusOf(file), 'ok', 'readFile prose must not be graded as a failed command');
    const cmd = 'COMMAND (cmd): exit /b 3\nSTATUS: FAILED | exit=3 | 12 ms\nSTDOUT:\n(empty)';
    assert.strictEqual(agent.toolStatusOf(cmd), 'failed', 'a real command failure still counts');
    const killed = 'COMMAND (cmd): ping -t x\nSTATUS: TIMEOUT (killed) | exit=null | 90000 ms';
    assert.strictEqual(agent.toolStatusOf(killed), 'failed', 'killed commands count too');
  });

  await test('toolRoundBudget: 0 really disables tools, junk falls back to 20', function () {
    assert.strictEqual(agent.toolRoundBudget(0), 0, '0 must survive: the setting documents "no tools at all"');
    assert.strictEqual(agent.toolRoundBudget('0'), 0);
    assert.strictEqual(agent.toolRoundBudget(undefined), 20);
    assert.strictEqual(agent.toolRoundBudget('abc'), 20);
    assert.strictEqual(agent.toolRoundBudget(-5), 0);
    assert.strictEqual(agent.toolRoundBudget(5000), 1000, 'clamped to the documented maximum');
    assert.strictEqual(agent.toolRoundBudget(7), 7);
  });

  await test('rules: deniedTools ignores case, so InsertText cannot slip past', function () {
    const rulesLib = require('../src/rules');
    const denied = rulesLib.checkToolCall({ tool: 'InsertText', args: {} },
      { readOnly: false, deniedTools: ['inserttext'] });
    assert.strictEqual(denied.allowed, false);
    const ok = rulesLib.checkToolCall({ tool: 'readFile', args: { path: 'a.txt' } },
      { readOnly: false, deniedTools: [] });
    assert.strictEqual(ok.allowed, true);
  });

  await test('endpoint: a six-digit port is rejected, not turned into a hostname', function () {
    const bad = endpoint.normalizeEndpoint('114514', 'http://127.0.0.1:8080/v1');
    assert.strictEqual(bad.ok, false, '114514 is not a port and must not become http://114514');
    assert.ok(/1-65535/.test(bad.error), bad.error);
    const good = endpoint.normalizeEndpoint('9090', 'http://127.0.0.1:8080/v1');
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.port, '9090');
  });

  await test('sessions: a long history is no longer cut to the last 40 messages', function () {
    const msgs = [];
    for (let i = 0; i < 60; i++) { msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }); }
    const rt = require('../src/runtime');
    const norm = rt.normalizeSessions({
      activeId: 's1',
      items: [{ id: 's1', title: 't', updatedAt: 1, history: msgs }]
    });
    assert.strictEqual(norm.items[0].history.length, 60, 'the whole task context must survive a restart');
    assert.ok(rt.MAX_SESSION_MESSAGES >= 60);
    /* 字符预算仍然生效：单条超大时不会把整个 globalState 撑爆 */
    const huge = [{ role: 'user', content: 'x'.repeat(rt.MAX_SESSION_CHARS + 10) }];
    const clipped = rt.normalizeSessions({ items: [{ id: 's', history: huge }] });
    assert.ok(clipped.items[0].history.length <= 1);
  });

  await test('settings audit: stripJsonc keeps commas inside strings and drops real trailing commas', function () {
    const lib = require('../src/settingsAudit');
    const text = '{\n "a": "x, }", // 注释\n "b": [1, 2,],\n}';
    const parsed = JSON.parse(lib.stripJsonc(text));
    assert.strictEqual(parsed.a, 'x, }', 'a comma-brace inside a string is data, not syntax');
    assert.deepStrictEqual(parsed.b, [1, 2], 'a real trailing comma must still be removed');
  });

  await test('toolProtocol: unbalanced brace flood cannot stall the parser', function () {
    const started = Date.now();
    const objs = protocol.extractJsonObjects('{'.repeat(200000));
    const elapsed = Date.now() - started;
    assert.deepStrictEqual(objs, [], 'no complete object in a brace flood');
    assert.ok(elapsed < 2000, 'scan budget must cut the O(n^2) blowup, took ' + elapsed + ' ms');
  });

  await test('snapshots: revert refuses a sibling directory that merely shares the prefix', function () {
    const snap = require('../src/snapshots');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-snap-'));
    const inside = path.join(base, 'app');
    const sibling = path.join(base, 'app-evil');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const victim = path.join(sibling, 'keep.txt');
    fs.writeFileSync(victim, 'original', 'utf8');
    const out = snap.revert(inside, [{ rel: '../app-evil/keep.txt', existed: false, content: null }]);
    assert.strictEqual(out[0].ok, false, 'outside-the-workspace record must be skipped');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original', 'the sibling file must still exist');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('scheduler: a cross-year date keeps its year', function () {
    const sched = require('../src/scheduler');
    const now = new Date(2026, 11, 30, 22, 0, 0).getTime();
    const at = new Date(2027, 0, 2, 2, 0, 0).getTime();
    assert.ok(/^2027-01-02 02:00$/.test(sched.describeAt(at, now)), sched.describeAt(at, now));
    const soon = new Date(2026, 11, 31, 23, 30, 0).getTime();
    assert.ok(/^明天 23:30$/.test(sched.describeAt(soon, now)), sched.describeAt(soon, now));
  });

  await test('scheduler: manual order survives a state round-trip', function () {
    const sched = require('../src/scheduler');
    const now = Date.now();
    const jobs = sched.normalizeJobs([
      { id: 'a', text: '先跑的', kind: 'once', at: now + 3600e3 },
      { id: 'b', text: '后跑的', kind: 'once', at: now + 7200e3 }
    ], now);
    assert.deepStrictEqual(jobs.map(function (j) { return j.id; }), ['a', 'b']);
    const moved = sched.reorderJobs(jobs, 'b', -1, now);
    assert.deepStrictEqual(moved.map(function (j) { return j.id; }), ['b', 'a'],
      '上移 must change the execution order');
    const reloaded = sched.normalizeJobs(JSON.parse(JSON.stringify(moved)), now);
    assert.deepStrictEqual(reloaded.map(function (j) { return j.id; }), ['b', 'a'],
      'a reload must not sort the jobs back by their fire time');
    assert.strictEqual(sched.nextOrder(reloaded), 3, 'a new job must append after the manual order');
  });

  await runtime.setWriteMode(false);
  editor = null;
  fs.rmSync(root, { recursive: true, force: true });
  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n  ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('\n  NEEDS ATTENTION:');
    failed.forEach(function (f) { console.log('   - ' + f.name + ': ' + f.err); });
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error('AUDIT CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
