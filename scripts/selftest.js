'use strict';

/* Offline self-test. No network, no vscode module, no npm dependencies.
 * Run with: node scripts/selftest.js   (or: npm run selftest)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createSseDecoder, buildRequestOptions, isLocalEndpoint, classifyError, extractReasoning } = require('../src/llmClient');
const { parseToolCall, hasBrokenToolTemplate } = require('../src/toolProtocol');
// agent.js imports vscode for its tool implementations; the pure helpers we
// test here only need a placeholder module at require time.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') { return { workspace: {}, window: {} }; }
  return originalLoad.apply(this, arguments);
};
const { historyLimit, subtaskLimit, isSubtaskMode, isWriteConfirm, confirmTimeoutMs, CONFIRM_TIMEOUT, SUBTASK_MAX_DEPTH, contextCharLimit, takeRecent, needsAutoRetry } = require('../src/agent');
Module._load = originalLoad;
const { isPathInside, truncate, truncateMiddle } = require('../src/pathUtils');
const rules = require('../src/rules');
const fileImport = require('../src/fileImport');
const proc = require('../src/processRunner');
const endpoint = require('../src/endpoint');
const taskCheck = require('../src/taskCheck');
const md = require('../media/markdown');
const manifest = require('../package.json');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  PASS  ' + name);
}

function makeError(props) {
  const err = new Error('synthetic');
  Object.keys(props).forEach(function (k) { err[k] = props[k]; });
  return err;
}

/* Build a minimal ZIP by hand so the zero-dependency reader can be tested
 * without shipping binary fixtures. CRC fields are left at 0 because our
 * reader does not use them. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = f.deflate ? zlib.deflateRawSync(data) : data;
    const method = f.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

try {
  check('SSE decoder reassembles split chunks and ignores comments', function () {
    const decoder = createSseDecoder();
    let events = [];
    [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":',
      '[{"delta":{"content":"lo"}}]}\n\n',
      ': keepalive\n\ndata: [DONE]\n\n'
    ].forEach(function (chunk) {
      events = events.concat(decoder.push(chunk));
    });
    events = events.concat(decoder.flush());
    assert.strictEqual(events.length, 3);
    assert.strictEqual(JSON.parse(events[0]).choices[0].delta.content, 'Hel');
    assert.strictEqual(JSON.parse(events[1]).choices[0].delta.content, 'lo');
    assert.strictEqual(events[2], '[DONE]');
  });

  check('SSE decoder handles CRLF frames', function () {
    const decoder = createSseDecoder();
    const events = decoder.push('data: {"a":1}\r\n\r\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(JSON.parse(events[0]).a, 1);
  });

  check('request builder targets /v1/chat/completions over https', function () {
    const built = buildRequestOptions({
      config: { baseUrl: 'https://api.example.com/v1/', proxy: '', extraCaFile: '' },
      apiKey: 'sk-test',
      pathSuffix: '/chat/completions',
      payload: '{"a":1}',
      stream: false,
      timeoutMs: 1234
    });
    assert.strictEqual(built.isHttps, true);
    assert.strictEqual(built.options.hostname, 'api.example.com');
    assert.strictEqual(built.options.path, '/v1/chat/completions');
    assert.strictEqual(built.options.headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(built.options.headers['Content-Length'], 7);
    assert.strictEqual(built.options.timeout, 1234);
  });

  check('request builder allows plain http for an intranet relay', function () {
    const built = buildRequestOptions({
      config: { baseUrl: 'http://192.168.1.10:8080/v1', proxy: '', extraCaFile: '' },
      apiKey: 'local', pathSuffix: '/chat/completions', payload: '{}', stream: false, timeoutMs: 5000
    });
    assert.strictEqual(built.isHttps, false);
    assert.strictEqual(String(built.options.port), '8080');
  });

  check('request builder rejects unsupported protocols', function () {
    assert.throws(function () {
      buildRequestOptions({
        config: { baseUrl: 'ftp://example.com/v1', proxy: '', extraCaFile: '' },
        apiKey: 'x', pathSuffix: '/chat/completions', payload: '{}', stream: false
      });
    }, /Unsupported protocol/);
  });

  check('empty baseUrl fails with a clear "set endpoint" hint (no built-in address)', function () {
    assert.throws(function () {
      buildRequestOptions({
        config: { baseUrl: '', proxy: '', extraCaFile: '' },
        apiKey: 'x', pathSuffix: '/chat/completions', payload: '{}', stream: false
      });
    }, /未设置模型服务地址|设置服务地址/);
  });

  check('tool protocol parses plain JSON, fenced JSON, mixed text and DSML/XML calls', function () {
    assert.deepStrictEqual(
      parseToolCall('{"tool":"readFile","args":{"path":"src/a.js"}}'),
      { tool: 'readFile', args: { path: 'src/a.js' } }
    );
    assert.strictEqual(parseToolCall('```json\n{"tool":"listFiles"}\n```').tool, 'listFiles');
    // 模型把说明文字写在 JSON 前后 —— 必须仍能识别出工具调用（否则会被误当最终回答、任务假完成）
    assert.deepStrictEqual(
      parseToolCall('工作区只有 3 个文件，先读第一个：\n{"tool":"readFile","args":{"path":"index.html"}}'),
      { tool: 'readFile', args: { path: 'index.html' } }
    );
    assert.deepStrictEqual(
      parseToolCall('{"tool":"listFiles","args":{}}\n说明：以上命令复制文件'),
      { tool: 'listFiles', args: {} }
    );
    // DeepSeek 等模型的 DSML / XML 函数调用格式（全角/半角竖线、有无 DSML 前缀）
    assert.deepStrictEqual(
      parseToolCall('<｜｜DSML｜｜ invoke name="readFile">\n<｜｜DSML｜｜ parameter name="args" string="false">{"path":"index.html"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>'),
      { tool: 'readFile', args: { path: 'index.html' } }
    );
    assert.strictEqual(
      parseToolCall('<invoke name="listFiles"><parameter name="args" string="false">{}</parameter></invoke>').tool,
      'listFiles'
    );
    // 模板退化兜底（v1.7.2）：竖线带空格、invoke 无闭合也要能识别出工具名
    assert.strictEqual(
      parseToolCall('< | | | | DSML | | | |\n<｜｜DSML｜｜ invoke name="runCommand">\n< | | DSML | |').tool,
      'runCommand'
    );
    // 坏模板检测（v1.7.3）：invoke 开标签整个缺失、只剩参数标签与孤立闭合——
    // 解析不出调用，但必须能识别为「坏模板」交给 agent 回填格式纠错；
    // 好调用与普通文字不能误判。
    const brokenLeak = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ parameter name="args" string="false">{"command":"dir","shell":"powershell"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    assert.strictEqual(parseToolCall(brokenLeak), null);
    assert.strictEqual(hasBrokenToolTemplate(brokenLeak), true);
    assert.strictEqual(hasBrokenToolTemplate('<｜｜DSML｜｜ invoke name="readFile"><｜｜DSML｜｜ parameter name="args" string="false">{"path":"a.txt"}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>'), false);
    assert.strictEqual(hasBrokenToolTemplate('任务已完成。'), false);
    assert.strictEqual(hasBrokenToolTemplate('HTML 里 <parameter> 不是标准标签。'), false);
    assert.strictEqual(parseToolCall('Just a normal answer.'), null);
    assert.strictEqual(parseToolCall('{not json}'), null);
  });

  check('path guard blocks traversal and absolute escapes', function () {
    const root = path.resolve('C:' + path.sep + 'proj');
    assert.strictEqual(isPathInside(root, path.join('src', 'a.js')), true);
    assert.strictEqual(isPathInside(root, '..' + path.sep + 'secret.txt'), false);
    assert.strictEqual(isPathInside(root, path.sep + 'etc' + path.sep + 'passwd'), false);
    assert.strictEqual(isPathInside(root, ''), false);
  });

  check('truncate keeps output bounded', function () {
    const out = truncate('abcdef', 3);
    assert.ok(out.indexOf('abc') === 0);
    assert.ok(out.indexOf('truncated') !== -1);
    assert.strictEqual(truncate('abc', 10), 'abc');
  });

  check('error hints point at the right Win7 remedy', function () {
    assert.ok(/extraCaFile/.test(classifyError(makeError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'cert' }))));
    assert.ok(/API key/.test(classifyError(makeError({ status: 401, body: '' }))));
    assert.ok(/\/v1/.test(classifyError(makeError({ status: 404, body: '' }))));
    assert.ok(/http\.proxy/.test(classifyError(makeError({ code: 'ECONNRESET', message: 'socket hang up' }))));
    assert.strictEqual(classifyError(makeError({ cancelled: true })), 'Cancelled.');
  });

  check('local endpoint detection (localhost / private LAN / cloud)', function () {
    assert.strictEqual(isLocalEndpoint('http://127.0.0.1:8080/v1'), true);
    assert.strictEqual(isLocalEndpoint('http://localhost:11434/v1'), true);
    assert.strictEqual(isLocalEndpoint('http://192.168.1.20:8080/v1'), true);
    assert.strictEqual(isLocalEndpoint('https://api.openai.com/v1'), false);
    assert.strictEqual(isLocalEndpoint(''), false);
  });

  check('empty API key omits the Authorization header', function () {
    const built = buildRequestOptions({
      config: { baseUrl: 'http://127.0.0.1:8080/v1', proxy: '', extraCaFile: '' },
      apiKey: '', pathSuffix: '/chat/completions', payload: '{}', stream: false
    });
    assert.strictEqual(built.options.headers.Authorization, undefined);
  });

  check('local connection errors point at the model server', function () {
    const hint = classifyError(makeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), { localEndpoint: true });
    assert.ok(/local model server/.test(hint));
  });

  check('real reasoning fields are extracted, absent ones stay empty', function () {
    assert.strictEqual(extractReasoning({ reasoning_content: '思考A' }), '思考A');
    assert.strictEqual(extractReasoning({ reasoning: '思考B' }), '思考B');
    assert.strictEqual(extractReasoning({ content: '普通回答' }), '');
    assert.strictEqual(extractReasoning(null), '');
  });

  /* ---- rules / memory / constraints ---- */

  check('rules are trimmed, deduplicated and capped', function () {
    const list = rules.normalizeRules(['  回答  用中文  ', '回答 用中文', '', null, '第二条']);
    assert.deepStrictEqual(list, ['回答 用中文', '第二条']);
    assert.strictEqual(rules.sanitizeRule('x'.repeat(500)).length, rules.MAX_RULE_CHARS);
    const many = [];
    for (let i = 0; i < 40; i++) { many.push('rule ' + i); }
    assert.strictEqual(rules.normalizeRules(many).length, rules.MAX_RULES);
  });

  check('system prompt combines defaults, memory and constraints with a priority order', function () {
    const prompt = rules.compileSystemPrompt({
      basePrompt: 'BASE',
      defaultRules: ['默认规则'],
      memoryRules: ['记忆规则'],
      rememberRules: true,
      constraints: { readOnly: true, deniedTools: ['insertText'], allowedReadGlobs: ['**/*'] }
    });
    assert.ok(prompt.indexOf('BASE') === 0);
    assert.ok(/默认规则/.test(prompt) && /记忆规则/.test(prompt));
    assert.ok(/运行约束/.test(prompt) && /只读模式/.test(prompt));
    assert.ok(/运行约束 > 长期通用要求/.test(prompt));
    const disabled = rules.compileSystemPrompt({
      basePrompt: 'BASE', defaultRules: [], memoryRules: ['记忆规则'], rememberRules: false, constraints: {}
    });
    assert.ok(!/记忆规则/.test(disabled), 'rememberRules=false must exclude memory');
    assert.ok(/工具能力/.test(prompt) && /createFile/.test(prompt), 'createFile capability must be injected regardless of basePrompt');
    assert.ok(/工具能力/.test(disabled), 'tool capability section must be present even with no base prompt rules');
    // runCommand must NOT be described as workspace-path-bound — that wording
    // made the model refuse legitimate whole-directory copy tasks (v0.3.19).
    assert.ok(/工作方式/.test(prompt), 'work-style guidance section must be present');
    assert.ok(/runCommand 不受.*工作区路径|不受工作区路径.*runCommand|runCommand 执行本机命令，不受此工作区路径限制/.test(prompt),
      'prompt must state runCommand is not bound by the workspace path limit');
    assert.ok(/Copy-Item|robocopy/.test(prompt), 'prompt must teach one-command whole-directory copy');
    assert.ok(/不要反复追问|选合理默认方案/.test(prompt), 'prompt must tell the model to act instead of asking endless clarifications');
    // v1.6.6: small-model work rules (distilled from mature agent prompts).
    assert.ok(/一轮只调一个工具/.test(prompt), 'one tool call per round must be stated');
    assert.ok(/失败恢复/.test(prompt) && /不要原样重试/.test(prompt), 'error-recovery playbook must be present');
    assert.ok(/动手前先看/.test(prompt) && /最小改动/.test(prompt), 'read-before-write and minimal-diff rules must be present');
    assert.ok(/完成必须有证据/.test(prompt), 'evidence-based completion rule must be present');
  });

  check('hard constraints block denied tools, writes and out-of-whitelist paths', function () {
    const c = { readOnly: true, deniedTools: ['runCommand'], allowedReadGlobs: ['src/**/*'] };
    assert.strictEqual(rules.checkToolCall({ tool: 'runCommand', args: {} }, c).allowed, false);
    assert.strictEqual(rules.checkToolCall({ tool: 'insertText', args: { text: 'x' } }, c).allowed, false);
    assert.strictEqual(rules.checkToolCall({ tool: 'createFile', args: { path: 'a.txt', text: 'x' } }, c).allowed, false, 'createFile blocked in read-only');
    assert.strictEqual(rules.checkToolCall({ tool: 'saveText', args: {} }, c).allowed, false);
    assert.strictEqual(rules.checkToolCall({ tool: 'readFile', args: { path: 'secret.txt' } }, c).allowed, false);
    assert.strictEqual(rules.checkToolCall({ tool: 'readFile', args: { path: 'src/a.js' } }, c).allowed, true);
    assert.strictEqual(rules.checkToolCall({ tool: 'importFile', args: { path: 'docs/a.md' } }, c).allowed, false);
    const writable = { readOnly: false, deniedTools: [], allowedReadGlobs: ['**/*'] };
    assert.strictEqual(rules.checkToolCall({ tool: 'createFile', args: { path: 'a.txt', text: 'x' } }, writable).allowed, true, 'createFile allowed in write mode');
  });

  check('glob whitelist matches nested paths but not siblings', function () {
    assert.strictEqual(rules.isPathAllowed('src/a.js', ['src/**/*']), true);
    assert.strictEqual(rules.isPathAllowed('src/deep/b.js', ['src/**/*']), true);
    assert.strictEqual(rules.isPathAllowed('docs/a.md', ['src/**/*']), false);
    assert.strictEqual(rules.isPathAllowed('a.md', ['*.md']), true);
    assert.strictEqual(rules.isPathAllowed('docs/a.md', ['*.md']), false);
  });

  /* ---- subtask mode + unbounded conversation rounds (v1.1.0) ---- */
  check('subtask mode is advertised in the prompt only when enabled and gated in code', function () {
    const on = rules.compileSystemPrompt({
      basePrompt: 'BASE', constraints: { subtaskMode: true }, subtaskMode: true
    });
    const off = rules.compileSystemPrompt({
      basePrompt: 'BASE', constraints: { subtaskMode: false }, subtaskMode: false
    });
    assert.ok(/子任务模式（已开启）/.test(on) && /runSubtask/.test(on));
    assert.ok(/子任务模式\n/.test(off) && !/子任务模式（已开启）/.test(off));
    assert.strictEqual(rules.checkToolCall({ tool: 'runSubtask', args: { goal: 'x' } }, { subtaskMode: false }).allowed, false);
    assert.strictEqual(rules.checkToolCall({ tool: 'runSubtask', args: { goal: 'x' } }, { subtaskMode: true }).allowed, true);
    assert.strictEqual(SUBTASK_MAX_DEPTH, 2, 'nested subtasks must be bounded');
  });

  /* ---- v1.11.8: 子任务一项一次，漏项要能兜住 ---- */
  check('subtasks: one call per plan item, budget echoed back, incomplete plans nudged', function () {
    const agent = require('../src/agent');
    assert.strictEqual(agent.countPlanItems('1) 读文件\n2) 改文件'), 2);
    assert.strictEqual(agent.countPlanItems('1. 甲\n2. 乙\n3. 丙'), 3);
    assert.strictEqual(agent.countPlanItems('3、丙'), 1);
    assert.strictEqual(agent.countPlanItems('- 读文件\n- 改文件'), 0, 'dash bullets are not a plan');
    assert.strictEqual(agent.countPlanItems(''), 0);

    const on = rules.compileSystemPrompt({
      basePrompt: 'BASE', constraints: { subtaskMode: true }, subtaskMode: true
    });
    assert.ok(/每一项各调用一次 runSubtask/.test(on), 'prompt must ask for one call per item');
    assert.ok(/不要把「已经委派过一次」当成任务结束/.test(on),
      'prompt must say one delegation is not the end of the task');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
    assert.ok(/剩余子任务额度/.test(src), 'subtask result must echo the remaining budget');
    assert.ok(/PLAN INCOMPLETE/.test(src), 'an incomplete plan must trigger a single nudge');
    assert.strictEqual(/planNudged = true/.test(src), true);
  });

  check('history / subtask budgets are configurable, not hard-coded to 10 rounds', function () {
    assert.strictEqual(historyLimit({ maxHistoryMessages: 400 }), 400);
    assert.strictEqual(historyLimit({ maxHistoryMessages: 1 }), 100, 'invalid values fall back safely');
    assert.strictEqual(historyLimit({}), 100);
    assert.strictEqual(subtaskLimit({ maxSubtasksPerRun: 20 }), 20);
    assert.strictEqual(subtaskLimit({}), 6);
    assert.strictEqual(isSubtaskMode({ subtaskMode: true }), true);
    assert.strictEqual(isSubtaskMode({ constraints: { subtaskMode: false } }), false);
  });

  check('confirm dialog timeout is configurable with a safe default and a distinct sentinel', function () {
    assert.strictEqual(confirmTimeoutMs({}), 120000, 'missing config falls back to 120 s');
    assert.strictEqual(confirmTimeoutMs({ confirmTimeoutMs: 0 }), 120000, '0 is invalid');
    assert.strictEqual(confirmTimeoutMs({ confirmTimeoutMs: -1 }), 120000, 'negative is invalid');
    assert.strictEqual(confirmTimeoutMs({ confirmTimeoutMs: 'abc' }), 120000, 'NaN is invalid');
    assert.strictEqual(confirmTimeoutMs({ confirmTimeoutMs: 45000 }), 45000);
    assert.strictEqual(typeof CONFIRM_TIMEOUT, 'string');
    assert.notStrictEqual(CONFIRM_TIMEOUT, undefined, 'timeout sentinel must never equal a real answer');
  });

  /* ---- write confirmation switch (v1.2.0) ---- */
  check('write confirmation toggle defaults ON and can be turned off in either config shape', function () {
    assert.strictEqual(isWriteConfirm({}), true, 'default is ON');
    assert.strictEqual(isWriteConfirm({ constraints: {} }), true);
    assert.strictEqual(isWriteConfirm({ confirmWrite: false }), false, 'top-level off');
    assert.strictEqual(isWriteConfirm({ constraints: { confirmWrite: false } }), false, 'constraints off');
    assert.strictEqual(isWriteConfirm({ confirmWrite: false, constraints: { confirmWrite: true } }), false);
    const desc = rules.describeConstraints({ confirmWrite: false });
    assert.ok(desc.some(function (l) { return /写入确认.*关闭/.test(l); }));
  });

  /* ---- file import ---- */

  check('text decoding handles UTF-8 BOM, UTF-16 LE and GBK', function () {
    assert.strictEqual(fileImport.decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text, 'a');
    assert.strictEqual(fileImport.decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00])).text, 'a');
    const gbk = fileImport.decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    assert.ok(gbk.text === '中文' || gbk.note === 'UTF-8', 'GBK should decode when ICU supports it');
    assert.strictEqual(fileImport.decodeXmlEntities('a &amp; b &lt;c&gt;'), 'a & b <c>');
  });

  check('docx XML becomes plain text, xlsx cells become CSV', function () {
    const doc = '<w:document><w:body><w:p><w:r><w:t>Hello &amp; 中文</w:t></w:r></w:p><w:p><w:t>第二段</w:t></w:p></w:body></w:document>';
    assert.ok(/Hello & 中文/.test(fileImport.docxToText(doc)));
    assert.ok(/第二段/.test(fileImport.docxToText(doc)));
    assert.strictEqual(fileImport.csvEscape('a,b'), '"a,b"');
    assert.strictEqual(fileImport.csvEscape('say "hi"'), '"say ""hi"""');
  });

  check('ZIP central directory + deflate extraction works with zero dependencies', function () {
    const zip = makeZip([
      { name: 'word/document.xml', data: '<w:document><w:p><w:t>压缩包里的中文</w:t></w:p></w:document>', deflate: true },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>姓名</t></si><si><t>分数</t></si></sst>', deflate: false }
    ]);
    const entries = fileImport.zipEntries(zip);
    assert.strictEqual(entries.length, 2);
    const doc = entries.filter(function (e) { return e.name === 'word/document.xml'; })[0];
    assert.ok(/压缩包里的中文/.test(fileImport.extractEntry(zip, doc).toString('utf8')));
    const ss = entries.filter(function (e) { return e.name === 'xl/sharedStrings.xml'; })[0];
    assert.ok(/姓名/.test(fileImport.extractEntry(zip, ss).toString('utf8')));
    assert.throws(function () { fileImport.zipEntries(Buffer.from('not a zip')); }, /有效的 docx/);
  });

  check('xlsx sheet XML with shared strings is converted to CSV rows', function () {
    const zip = makeZip([
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>姓名</t></si><si><t>分数</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>98</v></c></row>' +
        '</sheetData></worksheet>' }
    ]);
    const csv = fileImport.xlsxToCsv(zip, fileImport.zipEntries(zip));
    assert.ok(/姓名,分数/.test(csv));
    assert.ok(/姓名,98/.test(csv));
  });

  /* ---- safe process construction ---- */

  check('PowerShell uses EncodedCommand so quotes/backticks/dollars cannot break the argv', function () {
    const tricky = 'Write-Output "$env:USERNAME `& ^ | < > % ! \\ path with spaces 中文"';
    const spec = proc.buildSpawnSpec({ shell: 'powershell', command: tricky });
    assert.strictEqual(spec.shell, false);
    assert.strictEqual(spec.file, 'powershell.exe');
    assert.ok(spec.args.indexOf('-NonInteractive') !== -1);
    assert.ok(spec.args.indexOf('-EncodedCommand') !== -1);
    assert.strictEqual(spec.args[spec.args.indexOf('-ExecutionPolicy') + 1], 'Bypass',
      'Restricted-policy machines would otherwise refuse to run any .ps1');
    assert.ok(spec.args.indexOf('-ExecutionPolicy') < spec.args.indexOf('-EncodedCommand'),
      '-ExecutionPolicy must precede -EncodedCommand');
    assert.strictEqual(spec.stdio[0], 'ignore', 'stdin must be ignored or a prompt can hang forever');
    const decoded = proc.fromEncodedCommand(spec.args[spec.args.length - 1]);
    assert.ok(decoded.indexOf(tricky) !== -1, 'the original script must survive the round trip');
    assert.ok(/OutputEncoding/.test(decoded), 'UTF-8 console prelude must be prepended');
    assert.ok(/ProgressPreference\s*=\s*'SilentlyContinue'/.test(decoded),
      'progress records must be silenced, or Invoke-WebRequest floods STDERR with CLIXML');
    assert.ok(/SecurityProtocol.*-bor.*Tls12/.test(decoded) && /catch \{ \}/.test(decoded),
      'TLS 1.2 must be added (guarded) or https downloads fail on Win7 PS 5.1');
  });

  check('CMD receives the command as ONE argv element with a chcp 65001 prefix', function () {
    const spec = proc.buildSpawnSpec({ shell: 'cmd', command: 'echo a & echo b' });
    assert.strictEqual(spec.shell, false);
    assert.ok(spec.args[spec.args.length - 1].indexOf('echo a & echo b') !== -1, 'user command must survive intact');
    assert.ok(/^chcp 65001>nul&/.test(spec.args[spec.args.length - 1]), 'GBK output must be switched to UTF-8');
    assert.strictEqual(spec.windowsHide, true);
    assert.throws(function () { proc.buildSpawnSpec({ shell: 'cmd', command: '   ' }); }, /不能为空/);
    assert.ok(/墙钟/.test(proc.describeLimits({ timeoutMs: 60000, idleTimeoutMs: 15000, maxOutputBytes: 65536 })));
  });

  /* ---- endpoint / port normalization ---- */
  check('endpoint: port-only, host:port, full URL, custom path and invalid input', function () {
    const cur = 'http://192.168.1.20:8080/v1';
    let r = endpoint.normalizeEndpoint('9000', cur);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 'http://192.168.1.20:9000/v1');
    assert.strictEqual(r.port, '9000');
    r = endpoint.normalizeEndpoint('192.168.1.30:8080', cur);
    assert.strictEqual(r.value, 'http://192.168.1.30:8080/v1');
    r = endpoint.normalizeEndpoint('http://10.0.0.5:1234/v1', cur);
    assert.strictEqual(r.value, 'http://10.0.0.5:1234/v1');
    r = endpoint.normalizeEndpoint('https://llm.internal/ollama/v1', cur);
    assert.strictEqual(r.value, 'https://llm.internal/ollama/v1');
    assert.strictEqual(r.port, '443');
    assert.strictEqual(endpoint.normalizeEndpoint('', cur).ok, false);
    assert.strictEqual(endpoint.normalizeEndpoint('99999', cur).ok, false);
    assert.strictEqual(endpoint.normalizeEndpoint('ftp://host/v1', cur).ok, false);
    assert.strictEqual(endpoint.normalizeEndpoint('http://u:p@host/v1', cur).ok, false);
    assert.strictEqual(endpoint.shortEndpoint('http://192.168.1.20:8080/v1'), '192.168.1.20:8080/v1');
  });

  check('endpoint: no built-in default - port-only rejected when no current address', function () {
    const empty = endpoint.normalizeEndpoint('8080', '');
    assert.strictEqual(empty.ok, false, 'port-only must be rejected with no current address');
    assert.ok(/不内置|完整地址/.test(empty.error));
    // A full address still works from a blank state.
    const full = endpoint.normalizeEndpoint('http://10.1.2.3:9000/v1', '');
    assert.strictEqual(full.ok, true);
    assert.strictEqual(full.value, 'http://10.1.2.3:9000/v1');
  });

  /* ---- markdown rendering + XSS safety ---- */

  check('markdown: headings, inline styles, lists, code fence', function () {
    let h = md.render('# 标题\n## 小标题\n这是 **粗体**、*斜体*、~~删除~~ 和 `inline`.');
    assert.ok(/<h1>标题<\/h1>/.test(h));
    assert.ok(/<h2>小标题<\/h2>/.test(h));
    assert.ok(/<strong>粗体<\/strong>/.test(h));
    assert.ok(/<em>斜体<\/em>/.test(h));
    assert.ok(/<del>删除<\/del>/.test(h));
    assert.ok(/<code>inline<\/code>/.test(h));
    h = md.render('- 甲\n- 乙\n1. 一\n2. 二');
    assert.ok(/<ul><li>甲<\/li><li>乙<\/li><\/ul>/.test(h), 'unordered list');
    assert.ok(/<ol><li>一<\/li><li>二<\/li><\/ol>/.test(h), 'ordered list must not merge into ul');
    h = md.render('```js\nconst x = 1 < 2 && 3 > 2;\n```');
    assert.ok(/<pre data-lang="js"><code>const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;<\/code><\/pre>/.test(h), 'code fence escaped + lang tag');
    h = md.render('```python\nunclosed\n');
    assert.ok(/<pre data-lang="python">/.test(h), 'unclosed fence still renders during streaming');
  });

  check('markdown: table, blockquote, hr', function () {
    let h = md.render('| 姓名 | 分数 |\n| --- | ---: |\n| 张三 | 98 |');
    assert.ok(/<table>/.test(h) && /<th style="text-align:right">分数<\/th>/.test(h));
    assert.ok(/<td style="text-align:right">98<\/td>/.test(h));
    h = md.render('> 引用一\n> 引用二\n\n---');
    assert.ok(/<blockquote>/.test(h) && /引用一/.test(h) && /引用二/.test(h));
    assert.ok(/<hr>/.test(h));
  });

  check('markdown: XSS escaped, javascript: urls not clickable', function () {
    let h = md.render('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
    assert.ok(!/<script/.test(h) && !/<img/.test(h), 'raw HTML must be escaped');
    assert.ok(/&lt;script&gt;/.test(h));
    h = md.render('[点我](javascript:alert(1)) [安全](https://example.com/a?x=1&y=2)');
    assert.ok(!/href="javascript:/i.test(h), 'javascript: must not become href');
    assert.ok(/href="https:\/\/example.com\/a\?x=1&amp;y=2"/.test(h), 'https link allowed and & escaped');
    assert.strictEqual(md.safeUrl('data:text/html,x'), '');
    assert.strictEqual(md.safeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  });

  /* ---- completion check (taskCheck) ---- */

  check('taskCheck: intent detection separates "do it" from "explain it"', function () {
    const doIt = taskCheck.detectIntent('帮我复制工作区所有文件到 backup 目录');
    assert.strictEqual(doIt.wantsAction, true);
    assert.strictEqual(doIt.wantsWrite, true);
    const explain = taskCheck.detectIntent('解释一下这个函数的原理');
    assert.strictEqual(explain.wantsAction, false, 'pure questions must not be treated as tasks');
    const readOnly = taskCheck.detectIntent('列出 src 目录下的文件');
    assert.strictEqual(readOnly.wantsAction, true);
    assert.strictEqual(readOnly.wantsWrite, false);
  });

  check('taskCheck: a pasted error log counts as a task, not small talk', function () {
    // 用户把网页错误响应贴进来：正文没有动作动词，原来会被判成纯问答，
    // 模型只回一段分析就“完成”。长内容默认按任务处理。
    const log = 'HTTP/1.1 500 Internal Server Error\n' +
      '<html><body><h1>服务器内部错误</h1></body></html>\n' +
      'at com.example.DispatcherServlet.invoke(DispatcherServlet.java:99)\n' +
      'java.lang.NullPointerException: config must not be null\n' +
      '    ... 42 more frames\n'.repeat(12);
    const pasted = taskCheck.detectIntent(log);
    assert.ok(pasted.pasted, 'long paste must be flagged');
    assert.strictEqual(pasted.wantsAction, true, 'a pasted log is a work request');
    // 日志正文里偶然出现“是否/为什么”不能把整条消息拖回纯问答
    const noisy = log.replace('服务器内部错误', '请确认配置是否正确后再试');
    assert.strictEqual(taskCheck.detectIntent(noisy).wantsAction, true,
      'question words inside the pasted body must not suppress the task intent');
    // 明确提问仍然优先：贴日志 + 结尾问句 = 纯问答
    const asked = taskCheck.detectIntent(log + '\n这是什么原因？');
    assert.strictEqual(asked.wantsAction, false, 'an explicit question stays Q&A');
    // 开头带疑问词也算提问
    const askedHead = taskCheck.detectIntent('为什么会出现这个错误？\n' + log);
    assert.strictEqual(askedHead.wantsAction, false, 'a leading question stays Q&A');
  });

  check('taskCheck: "已完成" with zero tool calls is a false claim', function () {
    const r = taskCheck.evaluate({
      userText: '帮我把这些文件复制到 backup',
      answer: '已完成，所有文件都复制好了。',
      trace: { rounds: 1, tools: [], writeChecks: [] }
    });
    assert.strictEqual(r.verdict, 'false-claim');
    assert.strictEqual(r.level, 'fail');
    assert.ok(r.text.indexOf('已完成') !== -1);
    assert.ok(r.evidence.join(' ').indexOf('工具调用 0 次') !== -1);
  });

  check('taskCheck: task with zero tools but no claim is still no-action', function () {
    const r = taskCheck.evaluate({
      userText: '运行一下 npm test',
      answer: '建议你先在终端里运行 npm test 看看结果。',
      trace: { rounds: 1, tools: [], writeChecks: [] }
    });
    assert.strictEqual(r.verdict, 'no-action');
    assert.strictEqual(r.level, 'fail');
  });

  check('taskCheck: plain Q&A produces no card at all', function () {
    const r = taskCheck.evaluate({
      userText: '这个报错是什么意思',
      answer: '意思是端口被占用了。',
      trace: { rounds: 1, tools: [], writeChecks: [] }
    });
    assert.strictEqual(r.level, 'none');
    assert.strictEqual(r.verdict, 'talk-only');
  });

  check('taskCheck: all tools failed or were blocked', function () {
    const failed = taskCheck.evaluate({
      userText: '读取 src/a.js 并把内容告诉我',
      answer: '读不到。',
      trace: { rounds: 2, tools: [{ tool: 'readFile', status: 'failed' }], writeChecks: [] }
    });
    assert.strictEqual(failed.verdict, 'failed');
    assert.strictEqual(failed.level, 'fail');

    const blocked = taskCheck.evaluate({
      userText: '写入 src/a.js',
      answer: '写不了。',
      trace: { rounds: 2, tools: [{ tool: 'saveText', status: 'blocked' }], writeChecks: [] }
    });
    assert.strictEqual(blocked.verdict, 'blocked');
    assert.strictEqual(blocked.level, 'fail');
  });

  check('taskCheck: read-only answer for a write task is "incomplete"', function () {
    const r = taskCheck.evaluate({
      userText: '把这段代码写进 src/a.js',
      answer: '你可以自己粘贴进去。',
      trace: { rounds: 2, tools: [{ tool: 'readFile', status: 'ok', path: 'src/a.js' }], writeChecks: [] }
    });
    assert.strictEqual(r.verdict, 'incomplete');
    assert.strictEqual(r.level, 'warn');
  });

  check('taskCheck: verified write is "done"', function () {
    const r = taskCheck.evaluate({
      userText: '新建 src/b.js 写上 hello',
      answer: '已创建 src/b.js。',
      trace: {
        rounds: 2,
        tools: [{ tool: 'createFile', status: 'ok', path: 'src/b.js' }],
        writeChecks: [{ path: 'src/b.js', exists: true, size: 12, fresh: true }]
      }
    });
    assert.strictEqual(r.verdict, 'done');
    assert.strictEqual(r.level, 'ok');
    assert.ok(r.text.indexOf('磁盘上确认') !== -1);
  });

  check('taskCheck: write reported but file missing on disk is "unverified"', function () {
    const r = taskCheck.evaluate({
      userText: '新建 src/c.js',
      answer: '已创建。',
      trace: {
        rounds: 2,
        tools: [{ tool: 'createFile', status: 'ok', path: 'src/c.js' }],
        writeChecks: [{ path: 'src/c.js', exists: false, size: 0, fresh: false }]
      }
    });
    assert.strictEqual(r.verdict, 'unverified');
    assert.strictEqual(r.level, 'warn');
    assert.ok(r.text.indexOf('src/c.js') !== -1);
  });

  check('taskCheck: file copy done through runCommand counts as work', function () {
    const r = taskCheck.evaluate({
      userText: '复制工作区所有文件到 backup',
      answer: '已用 robocopy 复制完成。',
      trace: { rounds: 3, tools: [{ tool: 'runCommand', status: 'ok' }], writeChecks: [] }
    });
    assert.strictEqual(r.verdict, 'done');
  });

  check('taskCheck: max tool rounds and cancellation are not "done"', function () {
    const capped = taskCheck.evaluate({
      userText: '整理 src 目录',
      answer: '继续中。',
      trace: { rounds: 20, tools: [{ tool: 'readFile', status: 'ok' }], writeChecks: [], exhausted: true }
    });
    assert.strictEqual(capped.verdict, 'max-rounds');
    assert.strictEqual(capped.level, 'warn');

    const cancelled = taskCheck.evaluate({
      userText: '整理 src 目录',
      answer: '',
      trace: { rounds: 2, tools: [{ tool: 'readFile', status: 'ok' }], writeChecks: [], error: 'Cancelled.' }
    });
    assert.strictEqual(cancelled.verdict, 'cancelled');
    assert.strictEqual(cancelled.level, 'fail');
  });

  check('taskCheck: stream mode no longer blames streaming for a missing action', function () {
    const r = taskCheck.evaluate({
      userText: '帮我把文件复制过去',
      answer: '已完成。',
      trace: { rounds: 0, tools: [], writeChecks: [], streamMode: true }
    });
    assert.strictEqual(r.verdict, 'false-claim');
    assert.ok(r.text.indexOf('流式') === -1, 'v1.6.0 streams locally, so tools are not blocked by it');
  });

  check('taskCheck: successful read-only work stays silent (no card spam)', function () {
    const r = taskCheck.evaluate({
      userText: '列出 src 目录下的文件',
      answer: '共有 11 个文件。',
      trace: { rounds: 2, tools: [{ tool: 'listFiles', status: 'ok' }], writeChecks: [] }
    });
    assert.strictEqual(r.level, 'none');
    assert.strictEqual(r.verdict, 'done');
  });

  check('taskCheck: negative wording is not read as a completion claim', function () {
    assert.strictEqual(taskCheck.claimsCompletion('无法创建该文件，权限不足'), '');
    assert.strictEqual(taskCheck.claimsCompletion('已创建 src/a.js'), '已创建');
  });

  /* ---- context budget / pseudo streaming (v1.6.0) ---- */

  check('context: history is trimmed by characters, newest message always kept', function () {
    const big = 'x'.repeat(5000);
    const history = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: '最新问题' }
    ];
    const picked = takeRecent(history, 100, 6000);
    assert.strictEqual(picked.messages[picked.messages.length - 1].content, '最新问题', 'the newest message must survive');
    assert.ok(picked.chars <= 6000, 'budget must be respected: ' + picked.chars);
    assert.strictEqual(picked.dropped, 1, 'the oldest oversized message must be dropped');
    const single = takeRecent([{ role: 'user', content: big }], 100, 100);
    assert.strictEqual(single.messages.length, 1, 'a single oversized message is still kept');
    assert.strictEqual(contextCharLimit({ maxContextChars: 8000 }), 8000);
    assert.strictEqual(contextCharLimit({}), 8000);
    assert.strictEqual(contextCharLimit({ maxContextChars: 10 }), 8000, 'absurd values fall back to the default');
    assert.strictEqual(takeRecent(history, 1, 100000).messages.length, 1, 'message count is still a hard cap');
  });

  check('tool results keep head and tail so the model sees both ends', function () {
    const text = 'HEAD' + 'x'.repeat(10000) + 'TAIL';
    const out = truncateMiddle(text, 600);
    assert.ok(out.length < 900, 'must be shortened: ' + out.length);
    assert.ok(out.indexOf('HEAD') === 0, 'head must be kept');
    assert.ok(out.slice(-4) === 'TAIL', 'tail must be kept');
    assert.ok(/truncated \d+ chars/.test(out), 'the cut must be announced');
    assert.strictEqual(truncateMiddle('short', 600), 'short');
  });

  check('auto retry only for "talked but did nothing" verdicts', function () {
    assert.strictEqual(needsAutoRetry({ verdict: 'false-claim' }), true);
    assert.strictEqual(needsAutoRetry({ verdict: 'no-action' }), true);
    assert.strictEqual(needsAutoRetry({ verdict: 'done' }), false);
    assert.strictEqual(needsAutoRetry({ verdict: 'max-rounds' }), false);
    assert.strictEqual(needsAutoRetry(null), false);
  });

  check('workspace digest reaches the system prompt only when present', function () {
    const withDigest = rules.compileSystemPrompt({ constraints: {}, workspaceDigest: 'a.js\nb/c.md' });
    assert.ok(withDigest.indexOf('## 工作区文件') !== -1, 'digest section must be added');
    assert.ok(withDigest.indexOf('b/c.md') !== -1, 'file list must appear verbatim');
    const without = rules.compileSystemPrompt({ constraints: {} });
    assert.strictEqual(without.indexOf('## 工作区文件'), -1, 'no empty section when there is no workspace');
  });

  /* ---- inline <think> stripping (qwen3 hybrid thinking) ---- */
  check('splitInlineThinking moves <think> blocks out of the visible answer', function () {
    const { splitInlineThinking } = require('../src/agent');
    const a = splitInlineThinking('<think>先想一下</think>这是答案。');
    assert.strictEqual(a.visible, '这是答案。');
    assert.strictEqual(a.thinking, '先想一下');
    const b = splitInlineThinking('直接回答，没有思考块');
    assert.strictEqual(b.visible, '直接回答，没有思考块');
    assert.strictEqual(b.thinking, '');
    // 截断：只有开头没有闭合，其后全部算思考
    const c = splitInlineThinking('<think>思考到一半被截断');
    assert.strictEqual(c.visible, '');
    assert.ok(/截断/.test(c.thinking));
    // 孤立闭合标签也要清掉
    const d = splitInlineThinking('</think>答案在这里');
    assert.strictEqual(d.visible, '答案在这里');
    // 正文里带 tool_call 时原文不受影响（解析仍用全文，这里只验证剥壳）
    const e = splitInlineThinking('<think>计划</think>\n{"tool":"listFiles","args":{}}');
    assert.ok(e.visible.indexOf('listFiles') !== -1);
    // v1.6.7: 小模型写歪标签（大写/空格/thinking）时也必须剥离，不能漏到正文
    const variants = ['<THINK>想一下</THINK>答案', '<think >想一下</think >答案',
      '<thinking>想一下</thinking>答案', '<think\n>想一下</think>答案'];
    for (let i = 0; i < variants.length; i++) {
      const r = splitInlineThinking(variants[i]);
      assert.strictEqual(r.visible, '答案', 'tag variant leaked into the answer: ' + variants[i]);
      assert.ok(/想一下/.test(r.thinking), 'thinking text must be kept for: ' + variants[i]);
    }
    // 开闭标签不一致时也要成对处理，答案不能被吞进思考区
    const mixed = splitInlineThinking('<thinking>想一下</think>答案');
    assert.strictEqual(mixed.visible, '答案');
  });

  /* ---- manifest ---- */

  check('manifest: 1.11.14, no built-in endpoint/model, 22 commands, all activation events', function () {
    assert.strictEqual(manifest.displayName, 'ZSZ.Win7.VSCode.AIAgent');
    assert.strictEqual(manifest.version, '1.11.14');
    assert.strictEqual(manifest.publisher, 'dugudexiao');
    assert.strictEqual(manifest.author.name, 'dugudexiao');
    assert.strictEqual(manifest.icon, 'media/icon.png', 'marketplace icon must be declared');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'media', 'icon.png')), 'icon.png must exist');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'media', 'icon.svg')), 'activity-bar icon.svg must exist');
    assert.strictEqual(manifest.engines.vscode, '^1.70.0');
    assert.strictEqual(manifest.contributes.configuration.type, 'object', 'old VS Code needs an explicit type');
    const props = manifest.contributes.configuration.properties;
    assert.strictEqual(props['win7Agent.timeoutMs'].default, 1000000);
    assert.strictEqual(props['win7Agent.maxToolRounds'].maximum, 1000, 'tool round cap must be raised beyond 10');
    assert.ok(props['win7Agent.maxToolRounds'].default > 10);
    assert.strictEqual(props['win7Agent.maxHistoryMessages'].default, 100, 'history must no longer stop at 20 messages / 10 rounds');
    assert.strictEqual(props['win7Agent.maxHistoryMessages'].maximum, 2000);
    assert.strictEqual(props['win7Agent.subtaskMode'].default, false, 'subtask mode must default OFF');
    assert.strictEqual(props['win7Agent.maxSubtasksPerRun'].default, 6);
    assert.strictEqual(props['win7Agent.baseUrl'].default, '', 'no built-in endpoint address');
    assert.strictEqual(props['win7Agent.model'].default, '', 'no built-in model name');
    assert.strictEqual(props['win7Agent.constraints.allowShell'].default, true, 'shell must be ON by default');
    assert.strictEqual(props['win7Agent.constraints.confirmShell'].default, true, 'per-command confirmation must stay ON');
    assert.strictEqual(props['win7Agent.constraints.confirmWrite'].default, true, 'write confirmation switch must exist and default ON');
    /* v1.11.11: 旧的 win7Agent.allowWrite 已废弃，写入只由 readOnly + deniedTools 决定。 */
    assert.ok(!props['win7Agent.allowWrite'], 'the redundant legacy write switch must be gone');
    assert.strictEqual(props['win7Agent.confirmTimeoutMs'].default, 120000, 'confirm dialogs must time out by default');
    assert.strictEqual(props['win7Agent.confirmTimeoutMs'].minimum, 10000);
    assert.strictEqual(props['win7Agent.taskCheck'].default, true, 'completion check must exist and default ON');
    assert.strictEqual(props['win7Agent.maxContextChars'].default, 8000, 'context budget must exist');
    assert.strictEqual(props['win7Agent.maxContextChars'].minimum, 2000);
    assert.strictEqual(props['win7Agent.constraints.allowedShellCommands'].default.length, 0, 'default command whitelist must be empty = allow any command');
    assert.strictEqual(props['win7Agent.constraints.readOnly'].default, true);
    assert.strictEqual(props['win7Agent.constraints.deniedTools'].default.indexOf('runCommand'), -1, 'runCommand must not be blacklisted by default');
    const factoryRules = props['win7Agent.defaultRules'].default.join('\n');
    assert.ok(!/不修改任何文件|默认只做解释和建议/.test(factoryRules), 'factory rules must NOT forbid writing files');
    assert.strictEqual(manifest.contributes.commands.length, 22);
    const ids = manifest.contributes.commands.map(function (c) { return c.command; });
    assert.ok(ids.indexOf('win7Agent.switchProfile') !== -1, 'model-profile switcher command must exist');
    assert.ok(ids.indexOf('win7Agent.toggleShellConfirm') !== -1, 'shell-confirmation toggle command must exist');
    assert.ok(ids.indexOf('win7Agent.toggleWriteConfirm') !== -1, 'write-confirmation toggle command must exist');
    assert.ok(ids.indexOf('win7Agent.toggleSubtaskMode') !== -1, 'subtask-mode toggle command must exist');
    assert.ok(ids.indexOf('win7Agent.manageLessons') !== -1, 'auto-lesson manager command must exist');
    assert.strictEqual(props['win7Agent.autoLearn'].default, true, 'auto-lesson learning must default ON');
    ['win7Agent.showChanges', 'win7Agent.showChangeDiff', 'win7Agent.clearChanges', 'win7Agent.toggleChangeTracking'].forEach(function (id) {
      assert.ok(ids.indexOf(id) === -1, 'change-ledger command must be removed: ' + id);
    });
    ids.forEach(function (id) {
      assert.ok(manifest.activationEvents.indexOf('onCommand:' + id) !== -1, 'missing activationEvent for ' + id);
    });
  });

  /* ---- chat transcript look (v1.11.6) ---- */

  check('chat UI: user/AI turns are distinct, turns are split, flags are uniform, header shows model', function () {
    const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
    const user = /\.msg\.user\s*\{([\s\S]*?)\}/.exec(css);
    const assistant = /\.msg\.assistant\s*\{([\s\S]*?)\}/.exec(css);
    assert.ok(user, 'user bubble rule must exist');
    assert.ok(assistant, 'assistant bubble rule must exist');
    assert.ok(/margin-left:\s*\d+px/.test(user[1]), 'user bubble must be indented to the right');
    assert.ok(/margin-right:\s*\d+px/.test(assistant[1]), 'assistant bubble must be inset from the other side');
    assert.ok(/border-left:/.test(user[1]) && /border-left:/.test(assistant[1]), 'both sides need a left rail');
    assert.ok(/::before/.test(css) && /content:\s*'你'/.test(css) && /content:\s*'AI'/.test(css),
      'speaker labels must not depend on colour alone');

    // v1.11.7: 一次回答结束与下一问之间要有分割线
    const divider = /\.msg\.divider\s*\{([\s\S]*?)\}/.exec(css);
    assert.ok(divider, 'turn divider rule must exist');
    assert.ok(/border-top:\s*1px/.test(divider[1]), 'divider must be a hairline');
    const chatJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
    assert.ok(/function addTurnDivider\(\)/.test(chatJs), 'addTurnDivider must exist');
    assert.ok(/if \(role === 'user'\) \{ addTurnDivider\(\); \}/.test(chatJs),
      'every user turn after the first must be preceded by a divider');
    assert.ok(/classList\.contains\('divider'\)/.test(chatJs), 'divider must not be doubled');

    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
    /* v1.11.10: 复位按钮去掉了——四个开关外观统一，不再有「颜色看着像坏了」
     * 的问题，也就不需要一键回默认。 */
    assert.ok(!/id="resetFlags"/.test(view), 'the reset-flags menu item must be gone');
    assert.ok(!/_resetFlags/.test(view), 'the reset-flags handler must be gone too');
    assert.ok(!/'flag on'|'flag warn'/.test(chatJs), 'runtime flags must not be colour-coded by state');

    /* 顶部徽章显示模型名，而不是无意义的 key ok。 */
    assert.ok(/keyState\.textContent = modelName \|\| '未指定模型'/.test(chatJs),
      'header badge must show the active model name');
    assert.ok(!/'key ok'/.test(chatJs), 'the old "key ok" label must be gone');
  });

  /* v1.11.12: README 里的亮点图示必须真实存在，且要随 vsix 一起打进去——
   * 断链在扩展详情页上就是一张破图，而且只有装完才看得见。 */
  check('README feature diagrams exist and ship inside the extension', function () {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const srcs = [];
    const re = /<img[^>]+src="([^"]+)"/g;
    let m;
    while ((m = re.exec(readme))) { srcs.push(m[1]); }
    assert.ok(srcs.length >= 4, 'README must embed at least 4 feature diagrams, got ' + srcs.length);
    srcs.forEach(function (src) {
      assert.ok(/^media\/docs\/[a-z0-9.-]+\.svg$/.test(src), 'diagram must live under media/docs as svg: ' + src);
      const full = path.join(__dirname, '..', src);
      assert.ok(fs.existsSync(full), 'missing diagram file: ' + src);
      const svg = fs.readFileSync(full, 'utf8');
      assert.ok(/^<svg[\s\S]*<\/svg>\s*$/.test(svg.trim()), 'diagram must be a single well-formed svg: ' + src);
      assert.ok(/viewBox="0 0 \d+ \d+"/.test(svg), 'diagram needs a viewBox so it scales: ' + src);
      assert.ok(/font-family="[^"]*YaHei/.test(svg), 'diagram text must declare a CJK fallback font: ' + src);
    });

    /* 打包器按扩展名过滤 media/，svg 必须在白名单里，否则详情页图片是空的。 */
    const pack = fs.readFileSync(path.join(__dirname, 'pack-vsix.js'), 'utf8');
    assert.ok(/addDir\('media'[\s\S]{0,160}svg/.test(pack), 'packer must include media/**/*.svg');
  });

  /* v1.11.13: 导入的文件只属于「刚导入」这一小段时间，消息一发出去就该从输入框
   * 上方消失——内容早在导入时就进了历史，标签继续挂着会让人以为还没发出去。 */
  check('imported files are dropped from the composer once the message is sent', function () {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatView.js'), 'utf8');
    assert.ok(/_consumeAttachments\(\)\s*\{/.test(view), 'host must have a way to drop the chips');
    const send = /async _handleSend\(text, entry\)\s*\{([\s\S]*?)\n  \}/.exec(view);
    assert.ok(send, '_handleSend must exist');
    assert.ok(/this\._consumeAttachments\(\)/.test(send[1]),
      '_handleSend must clear the attachment chips after accepting the message');
    assert.ok(/type: 'attachments', items: \[\]/.test(view),
      'clearing must tell the webview to hide the bar, not just wipe host state');
    const chat = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
    assert.ok(/attachEl\.hidden = attachments\.length === 0/.test(chat),
      'empty list must hide the attachment bar');
  });

  /* v1.11.14: 设置体检——旧版本/同名插件留下的键要能被认出来，且不能误伤正常键。 */
  check('settings audit tells stale keys apart from our own', function () {
    const audit = require('../src/settingsAudit');
    /* JSONC：settings.json 里常有注释和尾逗号，解析不能炸。 */
    const parsed = JSON.parse(audit.stripJsonc([
      '{',
      '  // 用户注释',
      '  "win7Agent.model": "m",',
      '  /* 块注释 */',
      '  "win7Agent.list": [1, 2,],',
      '}'
    ].join('\n')));
    assert.strictEqual(parsed['win7Agent.model'], 'm');
    assert.deepStrictEqual(parsed['win7Agent.list'], [1, 2], 'trailing comma must be tolerated');

    const schema = audit.schemaKeys();
    assert.ok(schema.indexOf('constraints.readOnly') !== -1, 'schema keys must come from package.json');
    assert.ok(audit.RETIRED_KEYS.allowWrite, 'allowWrite must stay in the retired list');

    const sample = {
      'win7Agent.model': 'deepseek-flash',
      'win7Agent.allowWrite': false,
      'win7Agent.oldKnob': 1,
      'win7Agent.systemPrompt': audit.LEGACY_DEFAULTS.systemPrompt[0],
      'editor.fontSize': 14
    };
    const c = audit.classify(sample, schema, audit.RETIRED_KEYS, audit.LEGACY_DEFAULTS);
    assert.deepStrictEqual(c.retired.map(function (i) { return i.key; }), ['win7Agent.allowWrite']);
    assert.deepStrictEqual(c.unknown.map(function (i) { return i.key; }), ['win7Agent.oldKnob'],
      'only keys we no longer define may be flagged as unknown');
    assert.deepStrictEqual(c.legacy.map(function (i) { return i.key; }), ['win7Agent.systemPrompt'],
      'a value copied from an old default must be reported');
    assert.ok(!c.unknown.some(function (i) { return i.key === 'win7Agent.model'; }), 'live keys must never be flagged');

    /* 每个键在 package.json 里都必须真实存在，否则体检会把它当「不认识」。 */
    const props = manifest.contributes.configuration.properties;
    assert.strictEqual(schema.length, Object.keys(props).length);
  });

  /* 旧版本目录要能被点出来（VS Code 只启用一个，但旧 package.json 的默认值会被合并）。 */
  check('settings audit lists older copies of this extension on disk', function () {
    const audit = require('../src/settingsAudit');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsz-exts-'));
    const id = manifest.publisher + '.' + manifest.name;
    const active = path.join(root, id + '-' + manifest.version);
    fs.mkdirSync(active);
    fs.mkdirSync(path.join(root, id + '-0.3.12'));
    fs.mkdirSync(path.join(root, 'someone.else-1.0.0'));
    try {
      const list = audit.siblingVersions({ extensionPath: active });
      assert.strictEqual(list.length, 1, 'exactly one older copy must be reported');
      assert.strictEqual(list[0].version, '0.3.12');
      assert.ok(/0\.3\.12$/.test(list[0].path));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log('\nAll ' + passed + ' self-tests passed.');
} catch (err) {
  console.error('\nSELF-TEST FAILED: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
}
