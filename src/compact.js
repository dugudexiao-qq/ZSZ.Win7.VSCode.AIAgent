'use strict';

/*
 * Automatic context compaction. When the session history grows past the same
 * limits the agent already uses (message count + character budget), the older
 * turns are summarized into one compact message by the currently configured
 * model. The summary replaces the dropped turns *in the session history*, so
 * the conversation can run far longer than the hard cap without losing the
 * thread — instead of silently forgetting the beginning.
 *
 * Design notes:
 * - Compaction happens between runs (host side), never mid tool loop.
 * - The model call is best-effort: on any failure the run proceeds with the
 *   old takeRecent trimming, so compaction can never break a chat.
 * - A previous summary (marker prefix) is treated as regular old content and
 *   gets re-summarized together with the turns after it (recursive compaction).
 */

const { takeRecent, historyLimit, contextCharLimit } = require('./agent');
const { chatCompletion } = require('./llmClient');

const SUMMARY_MARKER = '【历史摘要】';
/* Below this many dropped turns a summarization round-trip is not worth it. */
const MIN_DROPPED = 4;
/* Hard cap for the text handed to the summarizer. */
const MAX_SUMMARY_INPUT_CHARS = 60000;
/* Cap for the summary itself. */
const MAX_SUMMARY_CHARS = 3000;

function historyChars(messages) {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    n += m && typeof m.content === 'string' ? m.content.length : 0;
  }
  return n;
}

/* True when takeRecent would drop at least MIN_DROPPED turns. Reuses the
 * agent's own limits so compaction and trimming agree on one definition of
 * "too long". */
function needsCompaction(history, config) {
  const list = Array.isArray(history) ? history : [];
  const recent = takeRecent(list, historyLimit(config), contextCharLimit(config));
  return { needed: recent.dropped >= MIN_DROPPED, dropped: recent.dropped, recent: recent };
}

function truncateForSummary(text) {
  const s = String(text || '');
  if (s.length <= MAX_SUMMARY_INPUT_CHARS) { return s; }
  const head = Math.floor(MAX_SUMMARY_INPUT_CHARS * 0.6);
  const tail = MAX_SUMMARY_INPUT_CHARS - head;
  return s.slice(0, head) + '\n…(中段过长已省略)…\n' + s.slice(s.length - tail);
}

function buildSummaryMessages(oldMessages) {
  const parts = [];
  const list = Array.isArray(oldMessages) ? oldMessages : [];
  list.forEach(function (m) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) { return; }
    parts.push((m.role === 'assistant' ? '助手：' : '用户：') + m.content.trim());
  });
  return [
    {
      role: 'system',
      content: '你是对话摘要器。把用户提供的旧对话压缩成一份中文要点摘要，供后续对话作为背景参考。' +
        '要求：保留用户的原始需求与目标、已完成的操作与结果（文件名、命令、关键数值）、尚未完成的部分、' +
        '以及任何重要的约定与偏好。用简短的条目列出，不要寒暄，不要评论，不超过 800 字。'
    },
    {
      role: 'user',
      content: '请把以下旧对话压缩成要点摘要：\n\n' + truncateForSummary(parts.join('\n\n'))
    }
  ];
}

/* Replace history in place with [summary message, ...kept turns]. Returns the
 * summary message so the caller can report sizes. */
function applySummary(history, keptMessages, summaryText) {
  const summary = String(summaryText || '').trim().slice(0, MAX_SUMMARY_CHARS);
  const message = {
    role: 'user',
    content: SUMMARY_MARKER + '以下是更早对话的要点摘要（由模型自动压缩，原始细节以实际文件为准）：\n' + summary
  };
  history.length = 0;
  history.push(message);
  for (let i = 0; i < keptMessages.length; i++) { history.push(keptMessages[i]); }
  return message;
}

/* One-shot compaction attempt. Returns a report or null when nothing was done
 * (not needed, too few turns, or the model call failed). */
async function compactIfNeeded(params) {
  const config = params.config;
  const apiKey = params.apiKey;
  const token = params.token;
  const history = params.history;
  if (!Array.isArray(history) || !config) { return null; }

  const check = needsCompaction(history, config);
  if (!check.needed) { return null; }

  const droppedCount = history.length - check.recent.messages.length;
  const oldMessages = history.slice(0, droppedCount);
  if (droppedCount < MIN_DROPPED) { return null; }

  let summary = '';
  try {
    const result = await chatCompletion({
      config: config,
      apiKey: apiKey || '',
      messages: buildSummaryMessages(oldMessages),
      stream: false,
      token: token,
      onDelta: function () {},
      onThought: function () {},
      onRetry: function () {}
    });
    summary = result && result.content ? result.content : '';
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (!summary.trim()) { return { ok: false, error: 'empty summary' }; }

  const beforeChars = historyChars(history);
  const message = applySummary(history, check.recent.messages, summary);
  return {
    ok: true,
    dropped: droppedCount,
    kept: check.recent.messages.length,
    summaryChars: message.content.length,
    beforeChars: beforeChars,
    afterChars: historyChars(history)
  };
}

module.exports = {
  compactIfNeeded,
  needsCompaction,
  buildSummaryMessages,
  applySummary,
  SUMMARY_MARKER,
  MIN_DROPPED,
  MAX_SUMMARY_INPUT_CHARS,
  MAX_SUMMARY_CHARS
};
