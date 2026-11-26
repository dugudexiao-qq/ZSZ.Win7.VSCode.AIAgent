'use strict';
/* ==========================================================================
   失败分类（v1.11.18）
   把「这一轮为什么没跑完」摊成几类，宿主把它随 error 事件发给面板，
   面板据此决定排队的消息还要不要接着发。

   为什么只让超时继续：超时是环境问题（模型服务慢、GGUF 刚加载、内网抖动），
   和队列里下一条任务的内容无关；而下一条往往很短，接着发大概率能跑通。
   认证失败 / 地址写错 / 用户点了 Stop 这类错误，下一条只会同样失败，
   继续发等于连着白等，所以照旧暂停等人处理。
   ========================================================================== */

/* 用户按 Stop：这一轮是被主动打断的，队列也该一起停下，等人再说。 */
const CANCEL_RE = /^cancelled\.?$|^已取消\.?$|^stopped\.?$/i;

/* 弹窗没人点（写文件 / 命令审批超时）不是环境问题：下一条排队任务很可能
  同样需要人点确认，自动继续只会在无人值守时连着一路超时。 */
const CONFIRM_TIMEOUT_RE = /CONFIRM TIMEOUT|确认超时|审批超时/i;

/* 只有「等太久」这一类：请求总时长到点、连接长时间没数据、代理握手超时。 */
const TIMEOUT_RE = /ETIMEDOUT|ESOCKETTIMEDOUT|total request time exceeded|no data for|timed out|timeout|stalled|超时/i;

/**
 * @param {string} message 抛出来的错误文本（宿主已按 classifyError 翻成人话）
 * @returns {'cancelled'|'confirm-timeout'|'timeout'|'other'}
 */
function classify(message) {
  const text = String(message === null || message === undefined ? '' : message).trim();
  if (!text) { return 'other'; }
  if (CANCEL_RE.test(text)) { return 'cancelled'; }
  if (CONFIRM_TIMEOUT_RE.test(text)) { return 'confirm-timeout'; }
  if (TIMEOUT_RE.test(text)) { return 'timeout'; }
  return 'other';
}

/**
 * 这一轮失败之后，排队里的下一条还要不要自动发出去。
 * @param {string} kind classify() 的结果
 */
function queueSafe(kind) {
  return kind === 'timeout';
}

module.exports = { classify, queueSafe };
