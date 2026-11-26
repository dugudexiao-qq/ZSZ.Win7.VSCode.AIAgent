'use strict';

/* 设置体检：把「不是我这一版定义的东西」从 win7Agent.* 里挑出来。
 *
 * 为什么要做：同一个扩展 ID 装过多个版本（0.3.x / 1.x），或者用过别人打包的同名
 * 增强版时，旧版的键会留在 settings.json 里继续生效；更隐蔽的是「旧版本内置的默认
 * 值」被写进用户设置——它不是用户自己配的，却会长期压住新版改进过的默认值。
 *
 * 原则：只自动删「我们明确废弃」的键；其余一律先报告，让用户点一下再清，
 * 绝不擅自改别人的配置文件。
 */

const fs = require('fs');
const path = require('path');
const manifest = require('../package.json');

/* vscode 只在真正执行时用到；延迟加载，让纯函数部分能在没有 VS Code 的环境里被测。 */
let vscodeApi = null;
function vs() {
  if (vscodeApi) { return vscodeApi; }
  try { vscodeApi = require('vscode'); } catch (e) { vscodeApi = {}; }
  return vscodeApi;
}

/* 明确废弃、且语义已由别的键接管的设置。删它们是安全的。 */
const RETIRED_KEYS = {
  'allowWrite': 'v1.11.11 起写入只由 constraints.readOnly + constraints.deniedTools 决定'
};

/* 旧版本内置默认值的指纹。settings.json 里的值与它逐字相同时，几乎可以肯定是
 * 从旧版「当前值」抄过来的，而不是用户自己写的——这类值会悄悄压住新版默认值。 */
const LEGACY_DEFAULTS = {
  'systemPrompt': [
    '你是在 Windows 7 的 VS Code 1.70 中运行的编程助手。回答简洁。如需调用工具，只回复一个 JSON 对象：{"tool":"readFile","args":{"path":"src/a.js"}}。可用工具：readFile、listFiles、getActiveFile、importFile、insertText、saveText、runCommand。否则正常回答。'
  ]
};

const PREFIX = 'win7Agent.';

/* 当前版本定义了哪些键（去掉 win7Agent. 前缀，便于和 settings.json 里的短名比对）。 */
function schemaKeys() {
  const props = (manifest.contributes &&
    manifest.contributes.configuration &&
    manifest.contributes.configuration.properties) || {};
  return Object.keys(props).map(function (k) {
    return k.indexOf(PREFIX) === 0 ? k.slice(PREFIX.length) : k;
  });
}

/* 宽松解析 JSONC：settings.json 允许注释和尾逗号，JSON.parse 直接炸。 */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (ch === '"') { inStr = false; }
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i += 1; }
      i += 2;
      continue;
    }
    if (ch === ',') {
      /* 尾逗号在字符串之外才删。原来是在整段文本上跑 /,\s*([}\]])/，
       * 会把 "note": "a, }" 这种字符串内容也改掉，JSON 依旧合法但值变了。 */
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k])) { k += 1; }
      if (k < text.length && (text[k] === '}' || text[k] === ']')) {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readSettings(file) {
  try {
    if (!fs.existsSync(file)) { return null; }
    /* 记事本另存的 settings.json 常带 BOM，JSON.parse 会直接抛错——旧代码
     * 把它当成「没有设置」，体检于是报「很干净」，实际上一项都没检查。 */
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) { return {}; }
    return JSON.parse(stripJsonc(text));
  } catch (e) {
    return null;
  }
}

/* 用户级 settings.json 的位置：globalStorageUri 是
 * <userData>/User/globalStorage/<id>，往上两级就是 User 目录。 */
function userSettingsPath(context) {
  const storage = context && context.globalStorageUri;
  if (!storage || !storage.fsPath) { return ''; }
  return path.join(path.dirname(path.dirname(storage.fsPath)), 'settings.json');
}

function settingsTargets(context) {
  const list = [];
  const user = userSettingsPath(context);
  if (user) { list.push({ file: user, target: vs().ConfigurationTarget.Global, label: '用户设置' }); }
  const folders = (vs().workspace && vs().workspace.workspaceFolders) || [];
  folders.forEach(function (f) {
    list.push({
      file: path.join(f.uri.fsPath, '.vscode', 'settings.json'),
      target: vs().ConfigurationTarget.Workspace,
      label: '工作区 ' + path.basename(f.uri.fsPath)
    });
  });
  return list;
}

/* 纯函数，方便自测：把一份设置对象分成「废弃键 / 不认识键 / 旧默认值」。 */
function classify(settings, schema, retired, legacy) {
  const out = { retired: [], unknown: [], legacy: [] };
  if (!settings || typeof settings !== 'object') { return out; }
  const retiredMap = retired || RETIRED_KEYS;
  const legacyMap = legacy || LEGACY_DEFAULTS;
  Object.keys(settings).forEach(function (key) {
    if (key.indexOf(PREFIX) !== 0) { return; }
    const bare = key.slice(PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(retiredMap, bare)) {
      out.retired.push({ key: key, value: settings[key], why: retiredMap[bare] });
      return;
    }
    if (schema.indexOf(bare) === -1) {
      out.unknown.push({ key: key, value: settings[key] });
      return;
    }
    const prints = legacyMap[bare];
    if (Array.isArray(prints) && prints.indexOf(settings[key]) !== -1) {
      out.legacy.push({ key: key, value: settings[key] });
    }
  });
  return out;
}

/* 同一 ID 的其它版本：扩展目录里 dugudexiao.win7-ai-agent-<ver> 这样的兄弟目录。
 * 老版本插件的默认值会被 VS Code 合并进设置界面，正是「过时设置混进来」的来源。 */
function siblingVersions(context) {
  const root = context && context.extensionPath;
  if (!root) { return []; }
  const parent = path.dirname(root);
  const id = manifest.publisher + '.' + manifest.name;
  const active = path.basename(root);
  let names = [];
  try {
    names = fs.readdirSync(parent);
  } catch (e) {
    return [];
  }
  return names.filter(function (n) {
    if (n === active) { return false; }
    if (n.indexOf(id + '-') !== 0) { return false; }
    try { return fs.statSync(path.join(parent, n)).isDirectory(); } catch (e) { return false; }
  }).map(function (n) {
    return { dir: n, version: n.slice(id.length + 1), path: path.join(parent, n) };
  }).sort(function (a, b) {
    return a.version.localeCompare(b.version, undefined, { numeric: true });
  });
}

function audit(context) {
  const schema = schemaKeys();
  const result = { files: [], retired: [], unknown: [], legacy: [], siblings: [], schemaCount: schema.length };
  settingsTargets(context).forEach(function (t) {
    const settings = readSettings(t.file);
    if (!settings) { return; }
    const c = classify(settings, schema, RETIRED_KEYS, LEGACY_DEFAULTS);
    result.files.push({ file: t.file, label: t.label, target: t.target, keyCount: Object.keys(settings).filter(function (k) { return k.indexOf(PREFIX) === 0; }).length });
    c.retired.forEach(function (it) { result.retired.push(Object.assign({ label: t.label, file: t.file, target: t.target }, it)); });
    c.unknown.forEach(function (it) { result.unknown.push(Object.assign({ label: t.label, file: t.file, target: t.target }, it)); });
    c.legacy.forEach(function (it) { result.legacy.push(Object.assign({ label: t.label, file: t.file, target: t.target }, it)); });
  });
  result.siblings = siblingVersions(context);
  return result;
}

function hasIssues(r) {
  return Boolean(r && (r.retired.length || r.unknown.length || r.legacy.length || r.siblings.length));
}

function clip(v, n) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  s = String(s === undefined ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function report(r) {
  const lines = [];
  lines.push('设置体检报告');
  lines.push('扩展 : ' + manifest.publisher + '.' + manifest.name + ' v' + manifest.version);
  lines.push('当前版本定义的设置项 : ' + r.schemaCount + ' 个');
  lines.push('');
  if (r.files.length) {
    lines.push('--- 检查过的文件 ---');
    r.files.forEach(function (f) {
      lines.push(f.label + '：' + f.keyCount + ' 个 win7Agent 键  ← ' + f.file);
    });
    if (!r.files.length) { lines.push('(没有找到 settings.json)'); }
  } else {
    lines.push('--- 检查过的文件 ---');
    lines.push('(没有找到可读的 settings.json)');
  }
  lines.push('');
  if (r.retired.length) {
    lines.push('--- 已废弃（可直接清理） ---');
    r.retired.forEach(function (it) {
      lines.push('· ' + it.key + ' = ' + clip(it.value, 60) + '  [' + it.label + ']');
      lines.push('  原因：' + it.why);
    });
    lines.push('');
  }
  if (r.unknown.length) {
    lines.push('--- 本版本不认识（多半是旧版/同名增强版留下的） ---');
    r.unknown.forEach(function (it) {
      lines.push('· ' + it.key + ' = ' + clip(it.value, 60) + '  [' + it.label + ']');
    });
    lines.push('  这些键不影响运行，但会一直躺在设置里误导人。清理后不可恢复。');
    lines.push('');
  }
  if (r.legacy.length) {
    lines.push('--- 值等于旧版内置默认值（会压住新版默认） ---');
    r.legacy.forEach(function (it) {
      lines.push('· ' + it.key + '  [' + it.label + ']');
      lines.push('  ' + clip(it.value, 120));
    });
    lines.push('  如果这不是你特意写的，建议删掉这一项，改用当前版本的默认值。');
    lines.push('');
  }
  if (r.siblings.length) {
    lines.push('--- 扩展目录里的其它版本 ---');
    r.siblings.forEach(function (s) {
      lines.push('· ' + s.dir + '（v' + s.version + '）');
    });
    lines.push('  同一 ID 的旧版本仍留在扩展目录里。VS Code 只会启用一个，但旧版 package.json');
    lines.push('  里的默认值可能被合并进设置界面，造成「没配过却有个奇怪的值」。建议删除。');
    lines.push('');
  }
  if (!hasIssues(r)) {
    lines.push('结论：干净。没有废弃键、不认识的键、旧默认值或重复版本。');
  } else {
    lines.push('结论：发现 ' + (r.retired.length + r.unknown.length) + ' 个可清理键、' +
      r.legacy.length + ' 个旧默认值、' + r.siblings.length + ' 个其它版本。');
  }
  return lines.join('\n');
}

/* 删除废弃键与不认识的键。只动 settings.json 里确实存在的项，逐条 try/catch，
 * 失败也继续——一条写不进去不该让整次清理中断。 */
async function cleanup(context, opts) {
  const o = opts || {};
  const r = audit(context);
  const cfg = vs().workspace.getConfiguration('win7Agent');
  const removed = [];
  const failed = [];
  const targets = [];
  if (o.retired !== false) { r.retired.forEach(function (it) { targets.push(it); }); }
  if (o.unknown) { r.unknown.forEach(function (it) { targets.push(it); }); }
  if (o.legacy) { r.legacy.forEach(function (it) { targets.push(it); }); }
  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    const bare = it.key.slice(PREFIX.length);
    try {
      await cfg.update(bare, undefined, it.target);
      removed.push(it.key + ' [' + it.label + ']');
    } catch (e) {
      failed.push(it.key + '：' + (e && e.message ? e.message : String(e)));
    }
  }
  return { removed: removed, failed: failed };
}

async function showReport(context) {
  const r = audit(context);
  const text = report(r);
  const api = vs();
  const doc = await api.workspace.openTextDocument({ content: text, language: 'plaintext' });
  await api.window.showTextDocument(doc, { preview: true });
  return r;
}

module.exports = {
  RETIRED_KEYS,
  LEGACY_DEFAULTS,
  PREFIX,
  schemaKeys,
  stripJsonc,
  classify,
  siblingVersions,
  audit,
  report,
  cleanup,
  hasIssues,
  showReport,
  userSettingsPath,
  settingsTargets
};
