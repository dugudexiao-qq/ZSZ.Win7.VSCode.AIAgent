'use strict';

/*
 * Project-level instructions from AGENTS.md in the workspace root.
 *
 * AGENTS.md is the 2026 de-facto standard for per-project agent rules
 * (read by Codex, Cursor, Copilot, Gemini CLI, Aider, Zed and friends).
 * Supporting it means users can tune THIS agent per project without
 * touching extension settings — e.g. the shell-syntax rules recommended
 * for Windows agents, house coding conventions, or task playbooks.
 *
 * Prompt injection only — same trust model as everything else in this
 * extension: a prompt is a request, not a security boundary. Hard
 * constraints (read-only, path whitelist, confirmations) are enforced in
 * code and always win, which the wrapper section below states explicitly.
 *
 * Caps keep a huge or adversarial AGENTS.md from eating the context window:
 * first 200 lines, then 8000 characters.
 */

const fs = require('fs');
const path = require('path');

const MAX_LINES = 200;
const MAX_CHARS = 8000;

/* Pure-ish: fs reads only inside `root`; returns '' on any problem. */
function readAgentsMd(root) {
  const base = String(root || '').trim();
  if (!base) { return ''; }
  try {
    const file = path.join(base, 'AGENTS.md');
    if (!fs.existsSync(file)) { return ''; }
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }  // strip BOM
    text = text.trim();
    if (!text) { return ''; }
    const lines = text.split('\n');
    if (lines.length > MAX_LINES) { text = lines.slice(0, MAX_LINES).join('\n') + '\n…（超过 ' + MAX_LINES + ' 行，已截断）'; }
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS) + '…（超过 ' + MAX_CHARS + ' 字符，已截断）'; }
    return text;
  } catch (e) {
    return '';
  }
}

/* Full wrapper section for compileSystemPrompt; '' when there is no file. */
function agentsMdSection(root) {
  const text = readAgentsMd(root);
  if (!text) { return ''; }
  return '## 项目说明（工作区根目录 AGENTS.md，用户为本项目写的规则）\n' +
    '- 本节内容由用户手工维护，遵守其中与任务相关的约定；与「运行约束」冲突时以运行约束为准。\n' +
    text;
}

module.exports = {
  MAX_LINES: MAX_LINES,
  MAX_CHARS: MAX_CHARS,
  readAgentsMd: readAgentsMd,
  agentsMdSection: agentsMdSection
};
