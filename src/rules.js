'use strict';

/*
 * Standing rules + hard constraints.
 * Pure logic, no vscode / no network, so it can be unit-tested offline.
 *
 * Three layers, from softest to hardest:
 *   1. defaultRules  - settings.json, ships with the extension (can be committed)
 *   2. memoryRules   - ExtensionContext.globalState, follows the user across sessions
 *   3. constraints   - settings.json, enforced in CODE before a tool ever runs
 * Layer 3 always wins over 1 and 2. A prompt is a request, not a security boundary.
 */

const { normalizeLessons } = require('./lessons');

const MAX_RULES = 20;
const MAX_RULE_CHARS = 200;

const DEFAULT_CONSTRAINTS = {
  readOnly: true,
  deniedTools: ['insertText'],
  allowedReadGlobs: ['**/*'],
  requireToolApproval: false,
  confirmWrite: true
};

function sanitizeRule(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RULE_CHARS);
}

function normalizeRules(list) {
  const out = [];
  const seen = Object.create(null);
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length && out.length < MAX_RULES; i++) {
    const rule = sanitizeRule(arr[i]);
    if (!rule) { continue; }
    const key = rule.toLowerCase();
    if (seen[key]) { continue; }
    seen[key] = true;
    out.push(rule);
  }
  return out;
}

function normalizeConstraints(input) {
  const c = input && typeof input === 'object' ? input : {};
  const denied = Array.isArray(c.deniedTools)
    ? c.deniedTools.map(function (t) { return String(t).trim(); }).filter(Boolean)
    : DEFAULT_CONSTRAINTS.deniedTools.slice();
  const globs = Array.isArray(c.allowedReadGlobs) && c.allowedReadGlobs.length
    ? c.allowedReadGlobs.map(function (g) { return String(g); }).filter(Boolean)
    : DEFAULT_CONSTRAINTS.allowedReadGlobs.slice();
  return {
    readOnly: c.readOnly !== false,
    deniedTools: denied,
    allowedReadGlobs: globs.length ? globs : DEFAULT_CONSTRAINTS.allowedReadGlobs.slice(),
    requireToolApproval: Boolean(c.requireToolApproval),
    confirmWrite: c.confirmWrite !== false,
    subtaskMode: c.subtaskMode !== false
  };
}

/* Minimal glob matcher: supports '*' (within a segment) and '**' (any depth).
 * Everything else is treated literally. Node 16 / no dependencies. */
function globToRegExp(glob) {
  const g = String(glob || '').replace(/\\/g, '/');
  let src = '^';
  for (let i = 0; i < g.length; i++) {
    const ch = g.charAt(i);
    if (ch === '*') {
      if (g.charAt(i + 1) === '*') {
        if (g.charAt(i + 2) === '/') { src += '(?:.*/)?'; i += 2; }
        else { src += '.*'; i += 1; }
      } else {
        src += '[^/]*';
      }
    } else if ('\\^$.|+?()[]{}'.indexOf(ch) !== -1) {
      src += '\\' + ch;
    } else {
      src += ch;
    }
  }
  return new RegExp(src + '$', 'i');
}

function isPathAllowed(relPath, patterns) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_CONSTRAINTS.allowedReadGlobs;
  return list.some(function (pattern) { return globToRegExp(pattern).test(rel); });
}

function describeConstraints(raw) {
  const c = normalizeConstraints(raw);
  const lines = [];
  if (c.readOnly) { lines.push('只读模式：文件写入工具 insertText / saveText / createFile 会被拦截；注意 runCommand 不受只读模式限制，仍可执行本机命令'); }
  if (c.deniedTools.length) { lines.push('禁用的工具：' + c.deniedTools.join('、')); }
  const unrestricted = c.allowedReadGlobs.length === 1 && c.allowedReadGlobs[0] === '**/*';
  if (!unrestricted) { lines.push('文件读取工具只允许读取匹配这些模式的文件：' + c.allowedReadGlobs.join('、')); }
  if (c.requireToolApproval) { lines.push('每次工具调用都需要用户逐次确认（这是独立于「命令确认」开关的工具审批，关闭命令确认不会关闭它）'); }
  lines.push('写入确认：' + (c.confirmWrite === false
    ? '关闭（createFile / saveText / 插入直接生效，不再弹窗；仍受写入模式与只读约束）'
    : '开启（每次写入前弹窗确认；菜单里可关闭）'));
  lines.push('子任务模式：' + (c.subtaskMode === false
    ? '关闭（runSubtask 不可用；菜单里可开启）'
    : '开启（可用 runSubtask 委派独立子任务，有数量与嵌套上限）'));
  lines.push('路径限制只适用于文件读写工具（readFile/importFile/saveText/createFile/insertText）：仅工作区内相对路径、拒绝二进制和超过 200 KB 的文件。runCommand 执行本机命令，不受此工作区路径限制——目标可以在工作区内外，它只受「命令确认开关」和「Shell 总开关」约束');
  return lines;
}

function compileSystemPrompt(params) {
  const p = params || {};
  const base = String(p.basePrompt || '').trim();
  const memoryEnabled = p.rememberRules !== false;
  const defaults = normalizeRules(p.defaultRules);
  const memory = memoryEnabled ? normalizeRules(p.memoryRules) : [];
  // Defaults come first, so a remembered rule can never silently override a
  // project-wide rule with the same text; duplicates are removed either way.
  const all = normalizeRules(defaults.concat(memory));
  const sections = [];
  if (base) { sections.push(base); }
  if (all.length) {
    sections.push(
      '## 长期通用要求（用户设定，对每一轮对话都生效，优先于你的默认习惯）\n' +
      all.map(function (r, i) { return (i + 1) + '. ' + r; }).join('\n')
    );
  }
  // Lessons learned from earlier tool failures that were actually fixed.
  // They live in their own store and their own section: they never consume the
  // user's rule slots, and they are visibly distinguishable from what the user
  // explicitly asked for (a wrong lesson must be deletable on its own).
  const lessons = memoryEnabled ? normalizeLessons(p.lessons) : [];
  if (lessons.length) {
    sections.push(
      '## 经验教训（历次执行中自动总结，下次直接照做，不要重复踩同一个坑）\n' +
      lessons.map(function (l, i) { return (i + 1) + '. ' + l.text; }).join('\n')
    );
  }
  const constraintLines = describeConstraints(p.constraints);  if (constraintLines.length) {
    sections.push(
      '## 运行约束（由扩展在工具执行层强制拦截，不要尝试绕过；被拒绝时改用已有信息回答）\n' +
      constraintLines.map(function (line) { return '- ' + line; }).join('\n')
    );
  }
  // Injected regardless of the user's basePrompt so tool capabilities are
  // always discoverable, even if their systemPrompt predates createFile.
  sections.push(
    '## 工具能力（扩展内置，始终可用；以 JSON 对象调用）\n' +
    '- 新建文件：{"tool":"createFile","args":{"path":"相对路径/新文件.md","text":"内容"}}，自动创建缺失的父目录；文件已存在时默认拒绝，确需覆盖再加 "overwrite":true。这是创建全新文件的首选方式。\n' +
    '- 改写已有文件：{"tool":"saveText","args":{"path":"相对路径","text":"新内容"}}（父目录须已存在）。\n' +
    '- 插入到当前编辑器：{"tool":"insertText","args":{"text":"内容"}}（只能改已打开的文件，不能新建）。\n' +
    '- 调用格式必须完整可解析：只用一行 JSON（{"tool":"工具名","args":{...}}），不要输出 DSML、invoke、parameter、tool_call、calls 等任何标签或包装；上一条回复因格式错误被丢弃时，直接按这个 JSON 格式重发，不要换回标签模板。\n' +
    '- 本机命令：{"tool":"runCommand","args":{"shell":"powershell","command":"命令"}}，执行 Windows 本机 PowerShell/CMD 命令。**runCommand 不受工作区路径边界限制**，可以读写工作区内外的路径；是否放行由「命令确认开关」决定（默认每条弹窗确认）。它也不受上面文件读写工具的 200 KB / 二进制 / 相对路径限制。\n' +
    '- **写文件一律用 createFile/saveText 工具，禁止用 echo、重定向或 here-string 拼文件**：cmd 的转义规则会把 JSON 和引号搅碎，写出的文件几乎必然损坏。整目录复制/批量操作才用命令（Copy-Item -Recurse、robocopy /E）。\n' +
    '- 命令读文件时中文若显示为乱码（如「涓讳俊鍙」），是编码问题不是文件损坏：PowerShell 用 Get-Content -Encoding UTF8，cmd 先执行 chcp 65001。优先用 readFile 工具，它没有编码问题。\n' +
    '- 命令里的字符串拼接一律用单引号（如 \'TOTAL=\' + $n），PowerShell 不用反斜杠转义双引号，写 \\\" 会直接语法错误。\n' +
    '- 读文件/列目录/取当前文件/导入文件：readFile / listFiles / getActiveFile / importFile，这几个工具的路径才必须是工作区内相对路径。\n' +
    '- 用户消息中以 @ 开头的路径（如 @src/app.js）是用户手动引用的工作区文件，需要其内容时用 readFile 读取，路径就是 @ 后面的部分。'
  );
  // Subtask mode is opt-out. Advertise the tool only when enabled, but always
  // state the boundary so a model that guesses the tool name learns why it was
  // blocked when the switch is off.
  sections.push(p.subtaskMode === false
    ? '## 子任务模式\n- 当前关闭：不要调用 runSubtask。用户可在菜单里开启「子任务模式」。'
    : '## 子任务模式（已开启）\n' +
      '- 复杂任务先拆成若干独立子任务，逐项执行并在最后汇总；不要因为步骤多就中途停下或反复追问。\n' +
      '- 委派独立子任务：{"tool":"runSubtask","args":{"goal":"子任务目标","context":"必要背景（可选）"}}。子代理在独立上下文中执行，只把结论返回给你，你必须阅读结论后再继续或汇总。\n' +
      '- 子任务有数量与嵌套上限，被拒绝时不要再试，改为自己用其他工具完成或基于已有信息回答。\n' +
      '- 纯问答、单步任务不需要子任务，直接回答即可。');
  // 综合成熟 Agent 提示词中适合小模型的部分：执行循环、先看后改、最小改动、
  // 失败恢复、证据化完成。全部写成一条一句的短条目——小模型对并列短句的
  // 遵循率明显高于长段落，且每条只讲一个动作。
  sections.push(
    '## 工作方式（重要，直接影响任务能否完成）\n' +
    '- 执行循环：一轮只调一个工具，调用后必须等待并阅读工具返回结果，再决定下一步；不要把「我打算调用工具」当作最终回答。\n' +
    '- 发出调用前自查 args：必填参数一个都不能空（runCommand 必须带 command，readFile/saveText/createFile 必须带 path，写入还必须带 text）。空参数的调用会被直接拒绝，浪费一整轮；若收到「requires args.xxx」报错，照报错里的示例原样重发。\n' +
    '- 单次写入上限 20000 字符：写大文件（如整页程序、长文档）前先按模块拆成多个小文件（例如代码拆成主文件+多个功能模块文件），逐个 createFile，每个都控制在 20000 字符以内；不要先试一次超长写入再等报错，那会浪费一整轮。\n' +
    '- 不要编造执行记录：工具结果只能由扩展回填，禁止在回复里写「user TOOL RESULT」「STATUS: OK」「DELETED: xxx」这类模拟输出，也不要假装某个命令已经跑过。工具调用必须是整条回复的唯一内容（纯 JSON），不要塞进叙述或代码块里；一条回复只放一个调用。\n' +
    '- 动手前先看：改写文件前先 readFile 确认现状，不要凭记忆或猜测改写；路径不确定时用 listFiles 或下方「工作区文件」清单核实，不要编造路径。\n' +
    '- 最小改动：只改与任务直接相关的部分，不顺手重排格式、重命名或重写无关内容。\n' +
    '- 失败恢复（关键）：工具报错时先完整读报错文本，原因写在里面。按顺序换姿势：1) 修正参数（路径写对；文件不存在或缺父目录改用 createFile）2) 换一个工具达到同一目的 3) 换过姿势仍失败就停下，向用户说明卡在哪一步、已试过什么。参数完全相同的调用不会成功，不要原样重试（扩展在重复失败后会拦截该调用）。\n' +
    '- 完成必须有证据：只有看到工具返回成功结果后才写「已完成」「已写入」；没有实际调用工具或结果失败时，直说没做、卡在哪一步——扩展会核对这一轮的真实动作。\n' +
    '- 不要用「工具没有这项能力」「目标在工作区外会被拦截」「不支持大文件/二进制」作为拒绝理由：这些限制只属于文件读写工具，runCommand 一条命令就能整目录复制（Copy-Item -Recurse 或 robocopy /E，含二进制和大文件）。\n' +
    '- 用户已给出明确任务（例如「复制工作区所有文件」「建个目录并复制过去」）时直接选合理默认方案执行，不要反复追问细节；只有真正需要拍板的风险操作（覆盖重要数据、目标在工作区外）才先确认，做完简要说明选了什么默认值。'
  );
  sections.push('## 优先级\n运行约束 > 长期通用要求（含经验教训）> 系统提示词 > 当前消息。若用户当前消息与长期通用要求或经验教训冲突，以长期通用要求为准并说明冲突。');
  // A small model cannot "browse" a repo the way a large one does. Handing it
  // the file list up front removes the blind listFiles rounds that used to eat
  // the tool budget before any real work started.
  const digest = String(p.workspaceDigest || '').trim();
  if (digest) {
    sections.push(
      '## 工作区文件（扩展自动提供，可能不完整）\n' +
      '- 路径都是相对工作区根目录的，可直接用于 readFile / saveText / createFile。\n' +
      '- 列表不全时用 listFiles 查，不要凭猜测编造路径。\n' + digest
    );
  }
  return sections.join('\n\n');
}

/* The actual gate. Called BEFORE any tool function is invoked. */
function checkToolCall(call, rawConstraints) {
  const c = normalizeConstraints(rawConstraints);
  const tool = String(call && call.tool || '');
  const args = call && call.args && typeof call.args === 'object' ? call.args : {};
  if (!tool) { return { allowed: false, reason: '空的工具名' }; }
  if (c.deniedTools.indexOf(tool) !== -1) {
    return { allowed: false, reason: '工具 ' + tool + ' 已在 win7Agent.constraints.deniedTools 中被禁用' };
  }
  if (tool === 'runSubtask' && c.subtaskMode === false) {
    return { allowed: false, reason: '子任务模式未开启（win7Agent.subtaskMode=false）；请在菜单中开启后再调用' };
  }
  if ((tool === 'insertText' || tool === 'saveText' || tool === 'createFile') && c.readOnly) {
    return { allowed: false, reason: '只读模式（win7Agent.constraints.readOnly = true），禁止写入或新建文件' };
  }
  if (tool === 'readFile' || tool === 'importFile') {
    const rel = String(args.path || '');
    if (!rel) { return { allowed: false, reason: tool + ' 缺少 args.path' }; }
    if (!isPathAllowed(rel, c.allowedReadGlobs)) {
      return { allowed: false, reason: '路径 ' + rel + ' 不在 win7Agent.constraints.allowedReadGlobs 白名单内' };
    }
  }
  return { allowed: true, reason: '' };
}

module.exports = {
  MAX_RULES: MAX_RULES,
  MAX_RULE_CHARS: MAX_RULE_CHARS,
  DEFAULT_CONSTRAINTS: DEFAULT_CONSTRAINTS,
  sanitizeRule: sanitizeRule,
  normalizeRules: normalizeRules,
  normalizeConstraints: normalizeConstraints,
  globToRegExp: globToRegExp,
  isPathAllowed: isPathAllowed,
  describeConstraints: describeConstraints,
  compileSystemPrompt: compileSystemPrompt,
  checkToolCall: checkToolCall
};
