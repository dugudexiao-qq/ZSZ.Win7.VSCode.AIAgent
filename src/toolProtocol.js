'use strict';

// 从文本中扫描出所有「括号平衡」的 JSON 对象候选，正确处理字符串里的括号与转义。
// 这样即使模型在 JSON 前后写了说明文字，也能把工具调用抠出来。
//
// 代价：每遇到一个 { 就从头往后扫到配对 }，正常情况下扫到就跳过（i = j），
// 但一段只有 { 没有 } 的文本（模型输出被截断、或代码块里全是花括号）会让每个
// { 都扫到结尾，退化成 O(n²)——几十万字符就足以把扩展主线程卡住。
// 用一个扫描预算封顶：超出就返回已经找到的完整对象，宁可少认一个调用。
const MAX_SCAN_WORK = 4000000;

function extractJsonObjects(text) {
  const out = [];
  const s = String(text || '');
  let work = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) !== '{') { continue; }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      if (++work > MAX_SCAN_WORK) { return out; }
      const ch = s.charAt(j);
      if (inString) {
        if (escaped) { escaped = false; }
        else if (ch === '\\') { escaped = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/* 尾逗号容忍：小模型输出的调用 JSON 常带多余尾逗号
 * （{"command":"...","shell":"cmd",}}），JSON 标准不接受，JSON.parse 直接
 * 失败，调用解析不出、坏模板检测也不认（形态太接近合法 JSON），原文漏进
 * 聊天区。逐字符扫描、跟踪字符串边界，只删「字符串之外、后面紧跟 } 或 ]
 * （允许空白）」的逗号——字符串内部出现的 ",}" 是数据，不能动。 */
function stripTrailingCommas(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s.charAt(j))) { j++; }
      if (j < s.length && (s.charAt(j) === '}' || s.charAt(j) === ']')) { continue; }
    }
    out += ch;
  }
  return out;
}

/* 修复两种「差一个键」的退化调用 JSON（意图 100% 明确，修回来即可执行，
 * 不必浪费一轮重试）：
 *   1. {"tool":"runCommand":{"shell":...}}   —— tool 值后直接跟冒号，漏了 "args":
 *   2. {"runCommand":{"shell":...}}          —— 工具名直接当了对象的键
 * 两种形态都只包含「工具名 + 参数表」两个字段，不会误伤普通 JSON。 */
const TOOL_NAMES = ['readFile', 'importFile', 'listFiles', 'getActiveFile',
  'insertText', 'saveText', 'createFile', 'runCommand', 'runSubtask'];

function repairShorthandTool(candidate) {
  /* 形态 1：{"tool":"runCommand":{...}} —— 在参数对象前只插入 ,"args":，
   * 不捕获/重拼任何大括号（正则配对括号必然在内层 } 与外层 } 之间出错）。 */
  let fixed = candidate.replace(/("tool"\s*:\s*"[^"]+"\s*)\s*:\s*(?=\{)/, '$1,"args":');
  if (fixed !== candidate) { return fixed; }
  /* 形态 2：{"runCommand":{...}} —— 工具名当键，改写键名部分。 */
  const keyed = candidate.match(/^\s*\{\s*"([A-Za-z0-9_]+)"\s*:\s*(?=\{)/);
  if (keyed && TOOL_NAMES.indexOf(keyed[1]) !== -1) {
    fixed = candidate.replace(/^\s*\{\s*"([A-Za-z0-9_]+)"\s*:/, '{"tool":"' + keyed[1] + '","args":');
    if (fixed !== candidate) { return fixed; }
  }
  return candidate;
}

function asToolCall(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { return null; }
  if (typeof obj.tool !== 'string' || !obj.tool.trim()) { return null; }
  let args = obj.args;
  /* Some models double-encode the arguments: args arrives as a JSON string
   * instead of an object. Coerce it, otherwise every path/command silently
   * becomes empty and the tool fails with a confusing "missing args" error. */
  if (typeof args === 'string') {
    const text = stripTrailingCommas(args.trim());
    if (text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text);
        args = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch (e) { args = {}; }
    } else { args = {}; }
  }
  const safeArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  return { tool: obj.tool.trim(), args: safeArgs };
}

function tryParseTool(s) {
  let candidate = String(s || '').trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) { candidate = fence[1].trim(); }
  if (!candidate || candidate.charAt(0) !== '{') { return null; }
  /* 注意：解析成功但里面没有 "tool" 键（如 {"runCommand":{...}} 这种工具名
   * 当键的合法 JSON）时 asToolCall 返回 null 而不是抛异常，所以「解析成功」
   * 不能直接 return——拿不到调用也要尝试修复形态。 */
  let parsed = null;
  try { parsed = asToolCall(JSON.parse(stripTrailingCommas(candidate))); } catch (e) { parsed = null; }
  if (parsed) { return parsed; }
  try {
    const fixed = repairShorthandTool(candidate);
    if (fixed !== candidate) {
      return asToolCall(JSON.parse(stripTrailingCommas(fixed)));
    }
  } catch (e) { /* unrecoverable */ }
  return null;
}

/* DeepSeek 系模型的工具调用由 tokenizer 特殊 token 包裹（<｜tool▁calls▁begin｜>
 * 等，竖线为全角 ｜）。小模型收尾时偶尔把特殊 token 泄漏进正文，残缺形态会把
 * 调用 JSON 的开括号一起吞掉：<｜tool":"runCommand","args":{...}}。
 * 归一化分两步：剥掉完整特殊 token；把 <｜tool 紧跟引号的残缺形态修回 {"tool，
 * 让后续 JSON 提取能接住这次调用。 */
/* 只认全角 ｜：它是 tokenizer 特殊 token 的特征（<｜tool▁calls▁begin｜>、
 * <｜User｜>）；半角 <|x|> 在正则/管道讨论里常见，不能动。 */
function normalizeSpecialTokens(s) {
  return String(s || '')
    .replace(/<[｜][A-Za-z0-9_▁][A-Za-z0-9_▁ .]{0,48}[｜]>/g, '')
    .replace(/<[｜]\s*tool\s*(?=["'])/gi, '{"tool');
}

// 模板退化兜底：长会话收尾时小模型会把竖线写成带空格的多段
// （< | | | | DSML | | | |）或全半角混排。先把 < 与 DSML 之间、DSML 之后的
// 竖线/空格序列统一归一成 <||DSML||，闭合同理，后续正则只认标准形态。
function normalizeDsmlBars(s) {
  return String(s || '')
    .replace(/<[｜|\s]{2,}DSML[｜|\s]{2,}/gi, '<||DSML||')
    .replace(/<\/[｜|\s]{2,}DSML[｜|\s]{2,}/gi, '</||DSML||');
}

// DeepSeek 等新模型会用 DSML / XML 风格的函数调用标签，例如：
//   <｜｜DSML｜｜ invoke name="readFile">
//   <｜｜DSML｜｜ parameter name="args" string="false">{"path":"index.html"}</｜｜DSML｜｜ parameter>
//   </｜｜DSML｜｜ invoke>
// 竖线可能是全角（｜）也可能是半角（|）；也可能没有 DSML 前缀，直接用 <invoke>。
function parseDsmlInvoke(content) {
  const s = normalizeDsmlBars(content);
  const bar = '[｜|]{2}';
  const openRe = new RegExp(
    '<\\s*(?:' + bar + '\\s*DSML\\s*' + bar + '\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"', 'i');
  const closeRe = new RegExp(
    '<\\s*\\/\\s*(?:' + bar + '\\s*DSML\\s*' + bar + '\\s*)?invoke\\s*>', 'i');
  const om = s.match(openRe);
  if (!om) { return null; }
  const tool = om[1].trim();
  const afterOpen = s.slice(om.index + om[0].length);
  const cm = afterOpen.match(closeRe);
  // 截断兜底：invoke 开标签出现了但闭标签没输出出来（上下文不够或模型
  // 格式退化）。取开标签之后的全部文本当 body 继续解析，能抠多少抠多少。
  const body = cm ? afterOpen.slice(0, cm.index) : afterOpen;
  const args = {};
  const paramRe = new RegExp(
    '<\\s*(?:' + bar + 'DSML' + bar + '\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*(?:' + bar + 'DSML' + bar + '\\s*)?parameter\\s*>',
    'gi');
  let p;
  while ((p = paramRe.exec(body)) !== null) {
    const name = p[1].trim();
    const attrs = p[2] || '';
    const raw = (p[3] || '').trim();
    const isStructured = /string\s*=\s*"false"/i.test(attrs);
    if (name === 'args') {
      if (isStructured) {
        const objs = extractJsonObjects(raw);
        let merged = {};
        for (let k = 0; k < objs.length; k++) {
          try {
            const o = JSON.parse(stripTrailingCommas(objs[k]));
            if (o && typeof o === 'object' && !Array.isArray(o)) { merged = o; break; }
          } catch (e) { /* keep looking */ }
        }
        if (Object.keys(merged).length) { Object.assign(args, merged); }
      } else {
        const objs = extractJsonObjects(raw);
        if (objs.length) {
          try {
            const o = JSON.parse(objs[0]);
            if (o && typeof o === 'object' && !Array.isArray(o)) { Object.assign(args, o); }
            else { args.args = raw; }
          } catch (e) { args.args = raw; }
        } else { args.args = raw; }
      }
    } else {
      args[name] = raw;
    }
  }
  // 没有 parameter 标签、但 invoke 体内直接是一个 JSON 对象的情况
  if (!Object.keys(args).length) {
    const objs = extractJsonObjects(body);
    for (let k = 0; k < objs.length; k++) {
      try {
        const o = JSON.parse(stripTrailingCommas(objs[k]));
        if (o && typeof o === 'object' && !Array.isArray(o)) { Object.assign(args, o); break; }
      } catch (e) { /* keep looking */ }
    }
  }
  return { tool: tool, args: args };
}

// 兜底：模型有时不写 invoke name 属性，而是把工具名放进
// <parameter name="tool"> 标签，外层还可能用 calls 等别的包装标签开头
// （invoke 开标签甚至整个缺失）。只要文本里有 DSML 参数标签且其中一个
// 名为 tool，就直接按参数收集组装调用。
function parseDsmlLooseParams(content) {
  const s = normalizeDsmlBars(content);
  if (!/(?:[｜|]{2}\s*DSML)/i.test(s)) { return null; }
  const bar = '[｜|]{2}';
  const looseRe = new RegExp(
    '<\\s*(?:' + bar + '\\s*DSML' + bar + '\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*(?:' + bar + '\\s*DSML' + bar + '\\s*)?parameter\\s*>',
    'gi');
  const loose = {};
  let q;
  while ((q = looseRe.exec(s)) !== null) {
    loose[q[1].trim()] = (q[3] || '').trim();
  }
  if (typeof loose.tool !== 'string' || !loose.tool.trim()) { return null; }
  const args = {};
  for (const key of Object.keys(loose)) {
    if (key === 'tool') { continue; }
    const raw = loose[key];
    if (key === 'args') {
      const objs = extractJsonObjects(raw);
      let assigned = false;
      for (let k = 0; k < objs.length; k++) {
        try {
          const o = JSON.parse(stripTrailingCommas(objs[k]));
          if (o && typeof o === 'object' && !Array.isArray(o)) { Object.assign(args, o); assigned = true; break; }
        } catch (e) { /* keep looking */ }
      }
      if (!assigned) { args.args = raw; }
    } else {
      args[key] = raw;
    }
  }
  return { tool: loose.tool.trim(), args: args };
}

/* Qwen 系模型即使被要求输出 JSON，也常按自己的训练模板输出：
 *   <tool_call>
 *   <function=listFiles>
 *   <parameter=args>
 *   {"path": "."}
 *   </parameter>
 *   </function>
 *   </tool_call>
 * 变体：function 用 name="X" 属性；parameter 里不是 JSON 而是纯文本；
 * 一条回复里连着多个 tool_call 块；block 里直接放 {"name":...,"arguments":{...}}
 * 的 JSON（Qwen 原生模板）；输出被截断导致 </tool_call> 缺失。 */
function parseToolCallBody(body) {
  const f = body.match(/<\s*function\s*[=|]\s*([A-Za-z0-9_.\-]+)\s*>/i) ||
    body.match(/<\s*function\s+name\s*=\s*"([^"]+)"/i);
  if (f) {
    const call = { tool: f[1].trim(), args: {} };
    const paramRe = /<\s*(?:parameter|param)\s*[=|]\s*([A-Za-z0-9_.\-]+)\s*>([\s\S]*?)<\s*\/\s*(?:parameter|param)\s*>/gi;
    let p;
    let sawParam = false;
    while ((p = paramRe.exec(body)) !== null) {
      sawParam = true;
      const name = p[1].trim();
      const raw = (p[2] || '').trim();
      if (name === 'args') {
        const objs = extractJsonObjects(raw);
        let merged = false;
        for (let k = 0; k < objs.length; k++) {
          try {
            const o = JSON.parse(stripTrailingCommas(objs[k]));
            if (o && typeof o === 'object' && !Array.isArray(o)) {
              Object.assign(call.args, o);
              merged = true;
              break;
            }
          } catch (e) { /* try next */ }
        }
        if (!merged) { call.args.args = raw; }
      } else {
        call.args[name] = raw;
      }
    }
    // 没有 parameter 标签时，function 体内直接放一个 JSON 对象
    if (!sawParam) {
      const objs = extractJsonObjects(body);
      for (let k = 0; k < objs.length; k++) {
        try {
          const o = JSON.parse(stripTrailingCommas(objs[k]));
          if (o && typeof o === 'object' && !Array.isArray(o)) { Object.assign(call.args, o); break; }
        } catch (e) { /* keep looking */ }
      }
    }
    return asToolCall(call);
  }
  // Qwen 原生变体：<tool_call>{"name":"x","arguments":{...}}</tool_call>
  const objs = extractJsonObjects(body);
  for (let k = 0; k < objs.length; k++) {
    try {
      const o = JSON.parse(stripTrailingCommas(objs[k]));
      if (!o || typeof o !== 'object' || Array.isArray(o)) { continue; }
      const name = typeof o.name === 'string' ? o.name : (typeof o.tool === 'string' ? o.tool : '');
      if (!name.trim()) { continue; }
      let args = o.arguments !== undefined ? o.arguments : (o.args !== undefined ? o.args : {});
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { args = {}; }
      }
      const shaped = asToolCall({ tool: name, args: args });
      if (shaped) { return shaped; }
    } catch (e) { /* try next */ }
  }
  return null;
}

/* 检测「模型想调工具但模板写坏了」的回复：文本里出现调用模板碎片
 * （DSML 标记、invoke / parameter / tool_call 标签），却解析不出任何可执行
 * 的调用——典型如 invoke 开标签整个丢失，只剩 parameter 标签和孤立的
 * 闭合标签，此时连工具名都拿不到，无法执行。调用方应向模型回一条格式
 * 纠错反馈并重试，而不是把模板原文当作回答显示给用户。 */
function hasBrokenToolTemplate(content) {
  const s = String(content || '');
  if (!s.trim()) { return false; }
  if (parseToolCalls(s).length) { return false; }
  // DeepSeek 特殊 token 泄漏（完整或残缺，全角 ｜ + 拉丁字母，如 <｜tool /
  // <｜User）：解析不出调用时一律视为坏模板，交给重试，不把原文漏给用户。
  if (/<[｜][A-Za-z]/.test(s)) { return true; }
  const n = normalizeDsmlBars(s);
  if (/<\/?\|\|DSML\|\|/i.test(n)) { return true; }
  // 只认无歧义的调用标签（invoke / tool_call / calls）。裸 <parameter> 与
  // <function> 不算：它们出现在 HTML/C++ 讨论里的概率不低，误判会让模型
  // 白白重试两轮。
  if (/<\s*\/?\s*(?:\|\|\s*DSML\s*\|\|\s*)?(?:invoke|tool_call|calls)\b/i.test(n)) { return true; }
  // Qwen 模板的 function 标签（<function=runCommand> / </function>）。收尾
  // 时开标签与 parameter 标签可能整体丢失，只剩参数值和孤立 </function>，
  // 此时连工具名都拿不到，必须交给重试。只在解析失败后才走到这里，普通
  // 讨论/代码里的 function 关键字（无 < 前缀）不会误判。
  if (/<\s*\/?\s*(?:\|\|\s*DSML\s*\|\|\s*)?function\s*[=>]/i.test(n)) { return true; }
  /* 「长得像工具调用」却解析不出的 JSON（截断/键序坏掉）：整块可提取的形态
   * 已被 repairShorthandTool 修回并执行，这里只兜提取不出或残缺的：
   *   {"tool":"runCommand":{"shell":…   —— tool 值后直接跟冒号（漏 "args":）
   *   {"runCommand":{"shell":…          —— 工具名直接当了键
   * 命中则交给重试，不把 JSON 原文当回答漏给用户。 */
  if (/"tool"\s*:\s*"[^"]+"\s*:\s*\{/.test(s)) { return true; }
  if (new RegExp('\\{\\s*"(?:' + TOOL_NAMES.join('|') + ')"\\s*:\\s*\\{').test(s)) { return true; }
  return false;
}

function parseToolCallTags(content) {
  const s = String(content || '');
  if (!/<\s*tool_call/i.test(s)) { return []; }
  const calls = [];
  const blockRe = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi;
  let block;
  let lastTail = '';
  while ((block = blockRe.exec(s)) !== null) {
    const shaped = parseToolCallBody(block[1]);
    if (shaped) { calls.push(shaped); }
    lastTail = s.slice(block.index + block[0].length);
  }
  // 截断兜底：块开了头但 </tool_call> 没输出出来（上下文不够或服务端截断）。
  // 优先取最后一个已闭合块之后的残余；整段只有未闭合开头时取整段。
  if (!calls.length) {
    const openRe = /<\s*tool_call\s*>([\s\S]*)$/i;
    const m = (lastTail && lastTail.match(openRe)) || s.match(openRe);
    if (m) {
      const shaped = parseToolCallBody(m[1]);
      if (shaped) { calls.push(shaped); }
    }
  }
  return calls;
}

/* Every tool call found in one reply, in priority order. Small models often
 * batch two calls into one message; the caller needs to know that only the
 * first one runs, otherwise the second is silently dropped. */
const KNOWN_ARG_KEYS = ['command', 'shell', 'path', 'text', 'overwrite', 'pattern', 'goal', 'task', 'description'];

/* 空参数兜底：只解析出一个调用且 args 为空时，若正文里另有一个「长得像
 * 参数表」的 JSON（全部键都在已知参数键集合内），把它捞回来当 args。
 * 小模型偶尔把参数拆到第二个 JSON 里或忘了塞进 args；能捞回就省一整轮
 * 重试。条件收得很紧（仅一个调用、键全部认识），避免误捞。 */
function rescueEmptyArgs(calls, blocks) {
  if (calls.length !== 1 || Object.keys(calls[0].args).length) { return; }
  for (let i = 0; i < blocks.length; i++) {
    let o;
    try { o = JSON.parse(stripTrailingCommas(blocks[i])); } catch (e) { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { continue; }
    if (typeof o.tool === 'string' || typeof o.name === 'string') { continue; }
    const keys = Object.keys(o);
    if (!keys.length) { continue; }
    if (keys.every(function (k) { return KNOWN_ARG_KEYS.indexOf(k) !== -1; })) {
      calls[0].args = o;
      return;
    }
  }
}

function parseToolCalls(content) {
  const text = normalizeSpecialTokens(String(content || ''));
  if (!text.trim()) { return []; }

  const dsml = parseDsmlInvoke(text);
  if (dsml) { return [dsml]; }

  const loose = parseDsmlLooseParams(text);
  if (loose) { return [loose]; }

  const tagged = parseToolCallTags(text);
  if (tagged.length) { return tagged; }

  const blocks = extractJsonObjects(text);
  const direct = tryParseTool(text.trim());
  if (direct) {
    const single = [direct];
    rescueEmptyArgs(single, blocks);
    return single;
  }

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const call = tryParseTool(blocks[i]);
    if (call) { out.push(call); }
  }
  rescueEmptyArgs(out, blocks);
  return out;
}

function parseToolCall(content) {
  return parseToolCalls(content)[0] || null;
}

module.exports = { parseToolCall, parseToolCalls, extractJsonObjects, hasBrokenToolTemplate };
