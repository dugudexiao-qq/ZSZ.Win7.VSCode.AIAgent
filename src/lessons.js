'use strict';

/*
 * Auto-lessons: turn "a tool failed, then the retry worked" into a short
 * standing note that goes into every later system prompt.
 *
 * Pure logic, no vscode / no network, so it can be unit-tested offline.
 *
 * Rules of the game:
 *   - only learn AFTER the problem is solved (the caller passes a failure that
 *     a later successful call already recovered from), never on a lone error;
 *   - the note must be short and actionable (<= MAX_LESSON_CHARS), because it
 *     is prepended to the prompt of a small model;
 *   - one note per category (stable id) — a repeated mistake bumps the hit
 *     count instead of piling up near-duplicates;
 *   - no fixed item count: keep every distinct lesson until a total character
 *     budget is reached, then drop the oldest. The budget bounds the prompt
 *     size without throwing away a just-learned note at an arbitrary "12";
 *   - lessons live in their own store: they never eat the user's 20 rule slots.
 */

/* 旧版 12 条硬上限已解除：现在按总字符预算裁剪（约 60+ 条普通经验），
 * 既不再莫名其妙丢掉刚学到的经验，也不会让提示词无限膨胀。 */
const MAX_LESSON_TOTAL_CHARS = 12000;
const MAX_LESSON_CHARS = 180;

/* 超出预算时从最旧的开始丢，至少保留一条，避免空列表。 */
function trimByBudget(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) { total += items[i].text.length; }
  while (items.length > 1 && total > MAX_LESSON_TOTAL_CHARS) {
    total -= items.shift().text.length;
  }
  return items;
}

function toolLabel(failure) {
  const tool = String((failure && failure.tool) || '');
  return tool ? '工具 ' + tool : '该工具';
}

/* Each entry: a recognizable error signature + the fix worth remembering.
 * Order matters: the first match wins, so put specific ones first. */
const PATTERNS = [
  {
    id: 'arg-missing',
    re: /requires args\.([A-Za-z][A-Za-z0-9_.]*)/i,
    build: function (m, f) {
      return toolLabel(f) + ' 必须带 args.' + m[1] + '：空参数会被直接拒绝，重发时一次写全，别用空 args 试探。';
    }
  },
  {
    id: 'unknown-tool',
    re: /unknown tool/i,
    build: function () {
      return '工具名只能取 readFile/importFile/listFiles/getActiveFile/insertText/saveText/createFile/runCommand/runSubtask，不能自造名字。';
    }
  },
  {
    id: 'too-long',
    re: /text too long|超过写入长度|too long to (write|insert)/i,
    build: function () {
      return '单次写入上限 20000 字符：写大文件前先按模块拆成多个小文件，逐个 createFile，每个都控制在 20000 字符内。';
    }
  },
  {
    id: 'overwrite',
    re: /already exists|use overwrite/i,
    build: function () {
      return 'createFile 遇到「文件已存在」：确需覆盖就在 args 里加 "overwrite":true，否则换文件名或改用 saveText。';
    }
  },
  {
    id: 'not-found',
    re: /file not found|ENOENT|no such file|does not exist|找不到|不存在/i,
    build: function () {
      return '目标文件不存在时改用 createFile（自动创建父目录）；saveText 只改写已有文件，不会新建。';
    }
  },
  {
    id: 'is-directory',
    re: /is a directory|EISDIR|是个目录|是目录/i,
    build: function () {
      return 'path 指向了目录：写入要给到具体文件名，列目录用 listFiles 或 runCommand。';
    }
  },
  {
    id: 'binary',
    re: /binary|二进制/i,
    build: function () {
      return 'readFile/importFile 读不了二进制：二进制或大文件改用 runCommand（Get-Content、certutil、Copy-Item）。';
    }
  },
  {
    id: 'outside-workspace',
    re: /escapes the workspace|outside the workspace|工作区之外|工作区外/i,
    build: function () {
      return '文件读写工具只接受工作区内相对路径；工作区外路径、整目录复制改用 runCommand（Copy-Item -Recurse / robocopy /E）。';
    }
  },
  {
    id: 'encoding',
    re: /锟|涓|乱码|mojibake|GBK/i,
    build: function () {
      return '命令输出中文乱码是编码问题：PowerShell 加 -Encoding UTF8，cmd 先 chcp 65001；读文件优先用 readFile。';
    }
  },
  {
    id: 'ps-quote',
    re: /ParserError|UnexpectedToken|Unrecognized token|意外的标记|缺少终止符|Missing closing/i,
    build: function () {
      return 'PowerShell 字符串拼接一律用单引号（\'TOTAL=\' + $n），不要用反斜杠转义双引号，写 \\" 会直接语法错误。';
    }
  },
  {
    id: 'command-not-found',
    re: /not recognized as an internal|不是内部或外部命令|无法将.*项识别|command not found/i,
    build: function () {
      return '命令不存在：先用 where / Get-Command 确认可执行名；PowerShell cmdlet 不要用 CMD 语法，反之亦然。';
    }
  },
  {
    id: 'timeout',
    re: /timed out|timeout|超时|stalled/i,
    build: function () {
      return '命令超时：缩小范围后重跑（-First / -TotalCount 限条数），不要一次扫全盘或整棵大目录。';
    }
  },
  {
    id: 'shell-off',
    re: /allowShell|Shell 总开关|shell is disabled/i,
    build: function () {
      return 'Shell 总开关关闭时 runCommand 不可用：改用文件工具完成，或让用户在菜单/设置里打开 allowShell。';
    }
  },
  {
    id: 'subtask-limit',
    re: /子任务数已达上限|子任务嵌套已达上限/i,
    build: function () {
      return '子任务数量或嵌套已达上限：不要再调用 runSubtask，改为自己用其它工具继续并汇总。';
    }
  },
  {
    id: 'bad-json',
    re: /JSON|Unexpected end of input|Unexpected token/i,
    build: function () {
      return '工具调用必须是合法 JSON：双引号、无尾逗号、不能换行；解析失败时改成一行 {"tool":"名","args":{...}} 重发。';
    }
  }
];

/* A user saying "no" is a decision, not a mistake to memorize. Same for the
 * constraint gate: retrying is already forbidden by the prompt. */
const SKIP = [
  /user rejected|用户拒绝|approval timed out|tools? approval timed out/i,
  /TOOL BLOCKED BY CONSTRAINT|已在 win7Agent\.constraints/i
];

function sanitizeLessonText(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LESSON_CHARS);
}

function normalizeLessons(list) {
  const out = [];
  const seen = Object.create(null);
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    const text = sanitizeLessonText(typeof raw === 'string' ? raw : (raw && raw.text));
    if (!text) { continue; }
    const id = String((raw && raw.id) || ('note-' + text.slice(0, 24).toLowerCase())).slice(0, 64);
    if (seen[id]) { continue; }
    seen[id] = true;
    out.push({
      id: id,
      text: text,
      hits: Math.max(1, Number(raw && raw.hits) || 1),
      at: Number(raw && raw.at) || 0
    });
  }
  return trimByBudget(out);
}

/* failure = { tool, error }. Returns { id, text } or null.
 * Call this only when a later call already proved the fix works. */
function deriveLesson(failure) {
  const error = String((failure && failure.error) || '');
  if (!error) { return null; }
  for (let i = 0; i < SKIP.length; i++) {
    if (SKIP[i].test(error)) { return null; }
  }
  for (let i = 0; i < PATTERNS.length; i++) {
    const p = PATTERNS[i];
    const m = error.match(p.re);
    if (m) {
      const text = sanitizeLessonText(p.build(m, failure));
      return text ? { id: p.id, text: text } : null;
    }
  }
  return null;
}

/* Same id -> replace text and bump hits, and move to the tail so the oldest
 * unused note is the one dropped when the cap is hit. */
function addLesson(list, incoming) {
  const items = normalizeLessons(list);
  const text = sanitizeLessonText(incoming && incoming.text);
  if (!text) { return items; }
  const id = String((incoming && incoming.id) || 'custom').slice(0, 64);
  const idx = items.findIndex(function (it) { return it.id === id; });
  let hits = 1;
  if (idx >= 0) {
    hits = (items[idx].hits || 1) + 1;
    items.splice(idx, 1);
  }
  items.push({ id: id, text: text, hits: hits, at: Date.now() });
  return trimByBudget(items);
}

module.exports = {
  MAX_LESSON_TOTAL_CHARS: MAX_LESSON_TOTAL_CHARS,
  MAX_LESSON_CHARS: MAX_LESSON_CHARS,
  PATTERNS: PATTERNS,
  sanitizeLessonText: sanitizeLessonText,
  normalizeLessons: normalizeLessons,
  deriveLesson: deriveLesson,
  addLesson: addLesson
};
