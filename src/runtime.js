'use strict';

const vscode = require('vscode');
const manifest = require('../package.json');
const { isLocalEndpoint } = require('./llmClient');
const { normalizeRules, normalizeConstraints, sanitizeRule, compileSystemPrompt, MAX_RULES } = require('./rules');
const lessonsLib = require('./lessons');
const profilesLib = require('./profiles');

const SECRET_KEY = 'win7Agent.apiKey';
const MEMORY_RULES_KEY = 'win7Agent.memoryRules';
const MEMORY_LESSONS_KEY = 'win7Agent.lessons';

let ctx = null;
let output = null;
let memoryKey = '';
let memoryRulesCache = [];
let memoryLessonsCache = [];
/* Recent log lines are kept in memory so "export diagnostics" can hand a
 * support person everything at once instead of asking for screenshots. */
const LOG_BUFFER_MAX = 400;
const logBuffer = [];

function initRuntime(context) {
  ctx = context;
  output = vscode.window.createOutputChannel(manifest.displayName);
  context.subscriptions.push(output);
  memoryRulesCache = getMemoryRules();
  memoryLessonsCache = getLessons();
}

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line;
  if (output) { output.appendLine(text); }
  logBuffer.push(text);
  if (logBuffer.length > LOG_BUFFER_MAX) { logBuffer.shift(); }
}

function getLogLines(limit) {
  const n = Number(limit) > 0 ? Number(limit) : logBuffer.length;
  return logBuffer.slice(-n);
}

function configDefault(key) {
  const prop = manifest.contributes.configuration.properties['win7Agent.' + key];
  return prop ? prop.default : undefined;
}

function cfgValue(c, key) {
  const v = c.get(key);
  return v === undefined ? configDefault(key) : v;
}

/* A toggle that always writes Global is silently overridden when the same key
 * exists in a workspace / folder settings.json. That made "命令确认：关" show
 * as off in the menu while runCommand still popped a dialog. Write to the
 * highest-priority scope that currently defines the key instead. */
function settingTarget(c, key) {
  const targets = vscode.ConfigurationTarget || {};
  if (typeof c.inspect !== 'function') { return targets.Global; }
  let seen;
  try { seen = c.inspect(key); } catch (e) { return targets.Global; }
  if (!seen) { return targets.Global; }
  if (seen.workspaceFolderValue !== undefined) {
    return targets.WorkspaceFolder === undefined ? targets.Workspace : targets.WorkspaceFolder;
  }
  if (seen.workspaceValue !== undefined) { return targets.Workspace; }
  return targets.Global;
}

function describeSettingScope(key) {
  const c = vscode.workspace.getConfiguration('win7Agent');
  if (typeof c.inspect !== 'function') { return 'effective=' + cfgValue(c, key) + ' (scope unknown)'; }
  const seen = c.inspect(key) || {};
  function mark(v) { return v === undefined ? '-' : String(v); }
  return 'default=' + mark(seen.defaultValue) + ' | user=' + mark(seen.globalValue) +
    ' | workspace=' + mark(seen.workspaceValue) + ' | folder=' + mark(seen.workspaceFolderValue) +
    ' | effective=' + mark(cfgValue(c, key));
}

function getConfig() {
  const c = vscode.workspace.getConfiguration('win7Agent');
  let proxy = '';
  try { proxy = vscode.workspace.getConfiguration('http').get('proxy') || ''; } catch (e) { log('Could not read http.proxy: ' + e.message); }

  const baseUrl = String(cfgValue(c, 'baseUrl') || '').replace(/\/+$/, '');
  const globs = cfgValue(c, 'constraints.allowedReadGlobs');
  const denied = cfgValue(c, 'constraints.deniedTools');
  const shellWhitelist = cfgValue(c, 'constraints.allowedShellCommands');

  const subtaskMode = cfgValue(c, 'subtaskMode') !== false;
  const constraints = Object.assign(normalizeConstraints({
    readOnly: cfgValue(c, 'constraints.readOnly'),
    deniedTools: Array.isArray(denied) ? denied : [],
    allowedReadGlobs: Array.isArray(globs) ? globs : [],
    requireToolApproval: cfgValue(c, 'constraints.requireToolApproval'),
    subtaskMode: subtaskMode
  }), {
    allowWrite: Boolean(cfgValue(c, 'allowWrite')),
    allowShell: Boolean(cfgValue(c, 'constraints.allowShell')),
    confirmShell: cfgValue(c, 'constraints.confirmShell') !== false,
    confirmWrite: cfgValue(c, 'constraints.confirmWrite') !== false,
    allowedShellCommands: Array.isArray(shellWhitelist) ? shellWhitelist.map(String) : []
  });

  return {
    baseUrl: baseUrl,
    model: String(cfgValue(c, 'model') || ''),
    preferShell: String(cfgValue(c, 'preferShell') || 'auto'),
    systemPrompt: String(cfgValue(c, 'systemPrompt') || ''),
    maxToolRounds: Number(cfgValue(c, 'maxToolRounds') || 0),
    maxHistoryMessages: Number(cfgValue(c, 'maxHistoryMessages') || 100),
    maxContextChars: Number(cfgValue(c, 'maxContextChars') || 0),
    subtaskMode: subtaskMode,
    maxSubtasksPerRun: Number(cfgValue(c, 'maxSubtasksPerRun') || 6),
    timeoutMs: Number(cfgValue(c, 'timeoutMs') || 1000000),
    confirmTimeoutMs: Number(cfgValue(c, 'confirmTimeoutMs') || 120000),
    stream: Boolean(cfgValue(c, 'stream')),
    extraCaFile: String(cfgValue(c, 'extraCaFile') || '').trim(),
    proxy: String(proxy).trim(),
    localEndpoint: isLocalEndpoint(baseUrl),
    defaultRules: normalizeRules(cfgValue(c, 'defaultRules')),
    rememberRules: cfgValue(c, 'rememberRules') !== false,
    autoLearn: cfgValue(c, 'autoLearn') !== false,
    taskCheck: cfgValue(c, 'taskCheck') !== false,
    constraints: constraints,
    process: {
      timeoutMs: Number(cfgValue(c, 'process.timeoutMs') || 60000),
      idleTimeoutMs: Number(cfgValue(c, 'process.idleTimeoutMs') || 15000),
      maxOutputBytes: Number(cfgValue(c, 'process.maxOutputBytes') || 65536)
    }
  };
}

function getExtensionInfo() {
  const author = manifest.author && manifest.author.name ? manifest.author.name : String(manifest.author || '');
  return {
    name: manifest.displayName,
    version: manifest.version,
    author: author,
    publisher: manifest.publisher,
    id: manifest.publisher + '.' + manifest.name,
    license: manifest.license,
    year: 2026,
    email: author && manifest.author.email ? manifest.author.email : 'dugudexiao@sina.com',
    target: 'VS Code 1.70.x on Windows 7 (target host: 1.70.2)'
  };
}

/* ---- remembered standing rules (persisted in globalState) ---- */

function getMemoryRules() {
  if (!ctx) { return memoryRulesCache.slice(); }
  try {
    return normalizeRules(ctx.globalState.get(MEMORY_RULES_KEY, []));
  } catch (e) {
    log('globalState unavailable, remembered rules are kept in memory only: ' + e.message);
    return memoryRulesCache.slice();
  }
}

async function setMemoryRules(list) {
  const rules = normalizeRules(list);
  memoryRulesCache = rules;
  if (!ctx) { return false; }
  try {
    await ctx.globalState.update(MEMORY_RULES_KEY, rules);
    return true;
  } catch (e) {
    log('globalState.update failed, rules kept in memory only: ' + e.message);
    return false;
  }
}

async function addMemoryRule(text) {
  const rule = sanitizeRule(text);
  if (!rule) { return { ok: false, message: '规则不能为空' }; }
  const current = getMemoryRules();
  if (current.some(function (r) { return r.toLowerCase() === rule.toLowerCase(); })) {
    return { ok: false, message: '这条规则已经记住了' };
  }
  if (current.length >= MAX_RULES) {
    return { ok: false, message: '规则数量已达上限 ' + MAX_RULES + ' 条，请先删掉一条' };
  }
  current.push(rule);
  const persisted = await setMemoryRules(current);
  return { ok: true, count: current.length, persisted: persisted, message: '已记住：' + rule };
}

async function removeMemoryRule(index) {
  const current = getMemoryRules();
  if (index < 0 || index >= current.length) { return { ok: false }; }
  current.splice(index, 1);
  await setMemoryRules(current);
  return { ok: true, count: current.length };
}

async function clearMemoryRules() {
  await setMemoryRules([]);
  return { ok: true, count: 0 };
}

/* ---- auto-lessons (separate store, separate budget) ----
 * Kept apart from memoryRules on purpose: a machine-written note must never
 * push out a rule the user typed by hand, and deleting a bad note must not
 * touch the user's rules. */

function getLessons() {
  if (!ctx) { return memoryLessonsCache.slice(); }
  try {
    return lessonsLib.normalizeLessons(ctx.globalState.get(MEMORY_LESSONS_KEY, []));
  } catch (e) {
    log('globalState unavailable, lessons are kept in memory only: ' + e.message);
    return memoryLessonsCache.slice();
  }
}

async function setLessons(list) {
  const items = lessonsLib.normalizeLessons(list);
  memoryLessonsCache = items;
  if (!ctx) { return false; }
  try {
    await ctx.globalState.update(MEMORY_LESSONS_KEY, items);
    return true;
  } catch (e) {
    log('globalState.update failed, lessons kept in memory only: ' + e.message);
    return false;
  }
}

/* Called when a failure has been recovered from. Returns { ok, text, count }. */
async function addLesson(lesson) {
  const text = lessonsLib.sanitizeLessonText(lesson && lesson.text);
  if (!text) { return { ok: false, message: '经验内容为空' }; }
  const current = getLessons();
  const before = current.map(function (it) { return it.text; }).join('\n');
  const next = lessonsLib.addLesson(current, { id: lesson.id, text: text });
  await setLessons(next);
  const repeated = current.some(function (it) { return it.id === String(lesson.id || 'custom'); });
  log('lesson ' + (repeated ? 'reinforced' : 'learned') + ': ' + text);
  return {
    ok: before !== next.map(function (it) { return it.text; }).join('\n') || repeated,
    text: text,
    count: next.length,
    repeated: repeated
  };
}

async function removeLesson(index) {
  const current = getLessons();
  if (index < 0 || index >= current.length) { return { ok: false, count: current.length }; }
  current.splice(index, 1);
  await setLessons(current);
  return { ok: true, count: current.length };
}

async function clearLessons() {
  await setLessons([]);
  return { ok: true, count: 0 };
}

/* ---- conversation sessions (persisted in globalState) ----
 * 一个会话就是一份发给模型的 history。切换会话只换 history 的引用，
 * 屏幕上的旧消息由 webview 自己保存快照，这里不存 DOM。
 * 上限：8 个会话 / 每个会话 40 条消息，防止 globalState 无限增长。 */

const SESSIONS_KEY = 'win7Agent.sessions';
const MAX_SESSIONS = 8;
const MAX_SESSION_MESSAGES = 40;

function normalizeSessions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.items) ? src.items : [];
  const items = [];
  list.forEach(function (s) {
    if (!s || typeof s !== 'object' || !s.id) { return; }
    const history = Array.isArray(s.history) ? s.history.filter(function (m) {
      return m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string';
    }).slice(-MAX_SESSION_MESSAGES) : [];
    const title = String(s.title || '').slice(0, 40);
    items.push({
      id: String(s.id),
      title: title || '新对话',
      updatedAt: Number(s.updatedAt) || 0,
      history: history
    });
  });
  return { activeId: String(src.activeId || ''), items: items.slice(0, MAX_SESSIONS) };
}

function getSessions() {
  if (!ctx) { return { activeId: '', items: [] }; }
  try {
    return normalizeSessions(ctx.globalState.get(SESSIONS_KEY, null));
  } catch (e) {
    log('globalState unavailable, sessions are kept in memory only: ' + e.message);
    return { activeId: '', items: [] };
  }
}

async function saveSessions(state) {
  if (!ctx) { return false; }
  try {
    await ctx.globalState.update(SESSIONS_KEY, normalizeSessions(state));
    return true;
  } catch (e) {
    log('globalState.update failed, sessions kept in memory only: ' + e.message);
    return false;
  }
}

/* ---- named model profiles (persisted in globalState) ----
 * 每个 profile 是一套「名字 + 服务地址 + 模型 + key」。切换 = 把 baseUrl/model
 * 写进设置、key 写进 SecretStorage。key 存在 profile 里只落在本机 globalState，
 * 与 SecretStorage 同级的安全边界（本机用户数据目录），文档里写明。 */

const PROFILES_KEY = 'win7Agent.profiles';
let profilesCache = [];

function getProfiles() {
  if (!ctx) { return profilesCache.slice(); }
  try {
    profilesCache = profilesLib.normalizeProfiles(ctx.globalState.get(PROFILES_KEY, []));
  } catch (e) {
    log('globalState unavailable, profiles are kept in memory only: ' + e.message);
  }
  return profilesCache.slice();
}

async function saveProfiles(list) {
  const items = profilesLib.normalizeProfiles(list);
  profilesCache = items;
  if (!ctx) { return false; }
  try {
    await ctx.globalState.update(PROFILES_KEY, items);
    return true;
  } catch (e) {
    log('globalState.update failed, profiles kept in memory only: ' + e.message);
    return false;
  }
}

async function addProfile(name, baseUrl, model, key) {
  const entry = {
    name: String(name || '').trim(),
    baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(model || '').trim(),
    key: String(key || ''),
    at: Date.now()
  };
  const current = getProfiles();
  const dup = current.some(function (p) { return p.name.toLowerCase() === entry.name.toLowerCase(); });
  if (dup) { return { ok: false, message: '同名配置已存在' }; }
  if (current.length >= profilesLib.MAX_PROFILES) {
    return { ok: false, message: '配置数量已达上限 ' + profilesLib.MAX_PROFILES + ' 个，请先删除一个' };
  }
  if (!entry.name || (!entry.baseUrl && !entry.model)) {
    return { ok: false, message: '配置缺少名字或服务地址' };
  }
  current.push(entry);
  await saveProfiles(current);
  log('profile added: ' + entry.name + ' -> ' + entry.baseUrl + ' / ' + entry.model);
  return { ok: true, count: current.length };
}

async function deleteProfile(name) {
  const current = getProfiles();
  const result = profilesLib.deleteProfile(current, name);
  if (!result.ok) { return { ok: false, message: '没有这个配置' }; }
  await saveProfiles(result.list);
  return { ok: true, count: result.list.length };
}

function activeProfileName() {
  const config = getConfig();
  return profilesLib.findActive(getProfiles(), config.baseUrl, config.model);
}

/* 把一个 profile 应用为当前配置：写 baseUrl/model 到设置（与手改同一作用域），
 * key 写进 SecretStorage（本地端点允许空 key）。 */
async function applyProfile(profile) {
  const cfg = vscode.workspace.getConfiguration('win7Agent');
  const target = settingTarget(cfg, 'baseUrl');
  await cfg.update('baseUrl', String(profile.baseUrl || ''), target);
  await cfg.update('model', String(profile.model || ''), target);
  await setApiKey(String(profile.key || ''));
  log('profile applied: ' + profile.name + ' -> ' + profile.baseUrl + ' / ' + profile.model);
  return getConfig();
}

function getRuleSummary() {
  const config = getConfig();
  const memory = getMemoryRules();
  const active = config.rememberRules ? normalizeRules(config.defaultRules.concat(memory)) : normalizeRules(config.defaultRules);
  return {
    defaultCount: config.defaultRules.length,
    memoryCount: memory.length,
    lessonCount: getLessons().length,
    autoLearn: config.autoLearn,
    total: active.length,
    rememberEnabled: config.rememberRules,
    constraints: config.constraints
  };
}

function getEffectivePrompt() {
  const config = getConfig();
  return compileSystemPrompt({
    basePrompt: config.systemPrompt,
    defaultRules: config.defaultRules,
    memoryRules: getMemoryRules(),
    lessons: getLessons(),
    rememberRules: config.rememberRules,
    constraints: config.constraints,
    subtaskMode: config.subtaskMode
  });
}

/* ---- API key (SecretStorage, with in-memory fallback) ---- */

async function getApiKey() {
  if (!ctx) { return memoryKey; }
  try {
    const stored = await ctx.secrets.get(SECRET_KEY);
    return stored || memoryKey;
  } catch (e) {
    log('SecretStorage unavailable on this machine, key kept in memory only: ' + e.message);
    return memoryKey;
  }
}

async function setApiKey(key) {
  memoryKey = key;
  if (!ctx) { return false; }
  try { await ctx.secrets.store(SECRET_KEY, key); return true; }
  catch (e) { log('SecretStorage.store failed, key kept in memory only: ' + e.message); return false; }
}

async function clearApiKey() {
  memoryKey = '';
  if (!ctx) { return; }
  try { await ctx.secrets.delete(SECRET_KEY); }
  catch (e) { log('SecretStorage.delete failed: ' + e.message); }
}

/* ---- write mode: flips the three switches that gate insertText/saveText ----
 * Both readOnly (code-level hard constraint) and the legacy allowWrite switch
 * must agree, and insertText must not sit in deniedTools. Returns the new on/off
 * state so callers can show a confirmation dialog first. */
function isWriteMode() {
  const c = getConfig().constraints;
  return c.allowWrite === true && c.readOnly === false && c.deniedTools.indexOf('insertText') === -1;
}

async function setWriteMode(enabled) {
  const cfg = vscode.workspace.getConfiguration('win7Agent');
  // All three gates must be written to the SAME scope, otherwise a workspace
  // setting can override only one of them and leave write mode half-on.
  const target = settingTarget(cfg, 'constraints.readOnly');
  await cfg.update('constraints.readOnly', !enabled, target);
  await cfg.update('allowWrite', enabled, target);
  const denied = (cfg.get('constraints.deniedTools') || []).map(String);
  const withoutInsert = denied.filter(function (t) { return t !== 'insertText'; });
  const next = enabled ? withoutInsert : (withoutInsert.indexOf('insertText') === -1 ? withoutInsert.concat(['insertText']) : withoutInsert);
  await cfg.update('constraints.deniedTools', next, target);
  return isWriteMode();
}

/* ---- shell confirmation: user-facing switch for constraints.confirmShell ----
 * true = each proposed command must be approved in a modal before it runs.
 * false = commands run without a confirmation dialog (lower safety). */
function isShellConfirm() {
  return getConfig().constraints.confirmShell === true;
}

async function setShellConfirm(enabled) {
  const cfg = vscode.workspace.getConfiguration('win7Agent');
  await cfg.update('constraints.confirmShell', enabled === true, settingTarget(cfg, 'constraints.confirmShell'));
  return isShellConfirm();
}

/* ---- write confirmation: user-facing switch for constraints.confirmWrite ----
 * true = each write (insert/save/create) must be approved in a modal.
 * false = writes go straight through (lower safety, but no repeated prompts). */
function isWriteConfirm() {
  return getConfig().constraints.confirmWrite === true;
}

async function setWriteConfirm(enabled) {
  const cfg = vscode.workspace.getConfiguration('win7Agent');
  await cfg.update('constraints.confirmWrite', enabled === true, settingTarget(cfg, 'constraints.confirmWrite'));
  return isWriteConfirm();
}

/* ---- subtask mode: delegate independent pieces of work to a sub-agent ---- */
function isSubtaskMode() {
  return getConfig().subtaskMode === true;
}

async function setSubtaskMode(enabled) {
  const cfg = vscode.workspace.getConfiguration('win7Agent');
  await cfg.update('subtaskMode', enabled === true, settingTarget(cfg, 'subtaskMode'));
  return isSubtaskMode();
}

function getContext() { return ctx; }
function showOutput() { if (output) { output.show(true); } }

module.exports = {
  initRuntime,
  getContext,
  getConfig,
  getExtensionInfo,
  getMemoryRules,
  setMemoryRules,
  addMemoryRule,
  removeMemoryRule,
  clearMemoryRules,
  getLessons,
  setLessons,
  addLesson,
  removeLesson,
  clearLessons,
  getSessions,
  saveSessions,
  normalizeSessions,
  MAX_SESSIONS,
  MAX_SESSION_MESSAGES,
  getRuleSummary,
  getEffectivePrompt,
  getApiKey,
  setApiKey,
  clearApiKey,
  isWriteMode,
  setWriteMode,
  isShellConfirm,
  setShellConfirm,
  isWriteConfirm,
  setWriteConfirm,
  isSubtaskMode,
  setSubtaskMode,
  getProfiles,
  saveProfiles,
  addProfile,
  deleteProfile,
  activeProfileName,
  applyProfile,
  settingTarget,
  describeSettingScope,
  log,
  getLogLines,
  showOutput
};
