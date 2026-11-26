'use strict';

/*
 * The "long-term rules" picker.
 *
 * Why this file exists: the old flow was a plain showQuickPick followed by a
 * separate showInputBox. Typing a new rule into the QuickPick box and pressing
 * Enter did nothing useful — the box is a filter, not an input, so Enter either
 * did nothing (no match) or silently deleted an existing rule (match on the
 * first row). Users read "the box where I type" as the place to type the rule.
 *
 * So the picker is built here as data: the first row is whatever the user just
 * typed, and Enter always means "use it". Pure functions, no vscode, so the
 * behaviour can be tested offline.
 */

const ADD_NEW = 'addNew';
const DUPLICATE = 'duplicate';

/** Rows that are always at the bottom of the menu (no rule attached). */
const ACTIONS = [
  { kind: 'action', action: 'add', label: '$(add) 记住一条新要求', description: '打开输入框，写一条会被长期记住的要求' },
  { kind: 'action', action: 'clear', label: '$(trash) 清空全部记忆', description: '出厂默认规则不受影响' },
  { kind: 'action', action: 'show', label: '$(eye) 查看生效提示词与约束', description: '输出到 Output 面板' },
  { kind: 'action', action: 'endpoint', label: '$(plug) 设置服务地址 / 端口', description: '可填完整 URL、主机:端口 或端口号' },
  { kind: 'action', action: 'settings', label: '$(gear) 打开约束设置', description: '只读 / 工具黑名单 / Shell / 超时' },
  { kind: 'action', action: 'settingsjson', label: '$(file-text) 直接编辑 settings.json', description: '设置界面空白时用这个' }
];

function sameRule(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Trimmed text the user typed, '' when there is nothing to remember. */
function typedRule(value, memory) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function isDuplicate(text, memory) {
  const list = Array.isArray(memory) ? memory : [];
  for (let i = 0; i < list.length; i++) {
    if (sameRule(list[i], text)) { return true; }
  }
  return false;
}

/**
 * Rows for the QuickPick. When the user has typed something, the typed rule
 * is row #1 — so Enter always does what the user meant, and existing rules
 * can never be hit by accident from a half-typed phrase.
 */
function buildItems(memory, summary, value, endpointLabel) {
  const list = Array.isArray(memory) ? memory : [];
  const text = typedRule(value, list);
  const items = [];

  if (text && isDuplicate(text, list)) {
    items.push({
      kind: DUPLICATE,
      alwaysShow: true,
      label: '$(info) 已经记过：' + text,
      description: '回车不会重复添加；退格改改文字可直接新增'
    });
  } else if (text) {
    items.push({
      kind: ADD_NEW,
      value: text,
      /* alwaysShow：输入再多也会留在第一行，回车永远有落点 */
      alwaysShow: true,
      label: '$(add) 记住：' + text,
      description: '回车即加入长期要求（之后每次对话都生效）'
    });
  }

  list.forEach(function (rule, index) {
    items.push({
      kind: 'rule',
      ruleIndex: index,
      label: rule,
      description: '选中后确认删除'
    });
  });

  ACTIONS.forEach(function (a) {
    const copy = {
      kind: a.kind,
      action: a.action,
      label: a.label,
      description: a.description
    };
    if (a.action === 'endpoint' && endpointLabel) {
      copy.description = '当前 ' + endpointLabel;
    }
    items.push(copy);
  });

  return items;
}

/**
 * What Enter means. A highlighted row wins (arrow keys still work); otherwise
 * the typed text is used, which is the regression this file fixes: pressing
 * Enter after typing must never be a no-op.
 */
function resolveAccept(selectedItems, value, memory) {
  const sel = selectedItems && selectedItems[0];
  if (sel) { return sel; }

  const list = Array.isArray(memory) ? memory : [];
  const text = typedRule(value, list);
  if (!text) { return undefined; }
  if (isDuplicate(text, list)) {
    return { kind: DUPLICATE, label: '$(info) 已经记过：' + text };
  }
  return { kind: ADD_NEW, value: text, label: '$(add) 记住：' + text };
}

/** Human-readable placeholder; keeps the counts the old prompt had. */
function placeholder(summary) {
  const s = summary || {};
  const c = s.constraints || {};
  return '长期通用要求：默认 ' + (s.defaultCount || 0) + ' 条 + 记忆 ' + (s.memoryCount || 0) +
    ' 条｜只读 ' + (c.readOnly ? '开' : '关') + '｜Shell ' + (c.allowShell ? '开' : '关') +
    '｜直接输入一条新要求后回车即可记住';
}

module.exports = {
  ADD_NEW: ADD_NEW,
  DUPLICATE: DUPLICATE,
  ACTIONS: ACTIONS,
  typedRule: typedRule,
  isDuplicate: isDuplicate,
  buildItems: buildItems,
  resolveAccept: resolveAccept,
  placeholder: placeholder
};
