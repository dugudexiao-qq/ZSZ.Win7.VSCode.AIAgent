'use strict';
/* ==========================================================================
   定时任务（v1.12.0）
   内网算力紧张时，把跑批的任务排到夜里，避开白天的排队高峰。

   一个任务就是「到点自动发出去的一句话」：
     { id, text, kind: 'once'|'daily', at: 绝对毫秒, time: 'HH:MM', enabled, ... }
   `at` 是唯一的触发依据（一次性与每天都是），`time` 只用来在每次跑完之后
   把 `at` 推到下一个时刻。这样「是否该跑」只有一个比较，不会出现
   「每天任务在 02:00 之后每一秒都算到期」那种经典 bug。

   本模块只做纯计算，不碰 vscode / 定时器，方便离线自测。
   ========================================================================== */

const ONCE = 'once';
const DAILY = 'daily';

/* 定时器只能活在扩展宿主进程里：宿主没运行时到点不会执行。启动时发现的
 * 「已经错过」的任务，超过这个宽限就直接跳过——凌晨两点的批处理在中午
 * 开机时补跑，既抢不到错峰的算力，还可能在你没准备时开始改文件。 */
const GRACE_MS = 10 * 60 * 1000;

/* 上限：任务存 globalState，每个任务可能带一段长提示词，别让它无限增长。 */
const MAX_JOBS = 20;
const MAX_TEXT = 4000;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** '02:00' / '2:00' / '２:00' / '2点30' / '2点' / '2' -> { h, m } | null */
function parseClock(text) {
  const raw = String(text === null || text === undefined ? '' : text)
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .trim();
  if (!raw) { return null; }
  let m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(raw);
  if (!m) { m = /^(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*分?$/.exec(raw); }
  if (!m) { m = /^(\d{1,2})$/.exec(raw); }
  if (!m) { return null; }
  const h = Number(m[1]);
  const mi = m[2] === undefined || m[2] === '' ? 0 : Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) { return null; }
  return { h: h, m: mi };
}

function fmtClock(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 把 'HH:MM' 落到某一天（以 from 所在日期为准）的时间戳。 */
function clockOnDay(time, from) {
  const hm = parseClock(time);
  if (!hm) { return null; }
  const base = new Date(from);
  base.setHours(hm.h, hm.m, 0, 0);
  return base.getTime();
}

/** 下一个 HH:MM（严格晚于 from）：今天的还没到就是今天，否则明天。 */
function nextDailyAt(time, from) {
  const today = clockOnDay(time, from);
  if (today === null) { return null; }
  if (today > from) { return today; }
  const d = new Date(today);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function newId(now) {
  return 'j' + (now || Date.now()).toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36);
}

/** 存进 globalState 之前把每一项收敛成确定形状，坏数据直接丢掉。 */
function normalizeJob(job, now) {
  if (!job || typeof job !== 'object') { return null; }
  const text = String(job.text || '').replace(/\s+$/, '');
  if (!text.trim()) { return null; }
  const kind = job.kind === DAILY ? DAILY : ONCE;
  let at = Number(job.at);
  let time = String(job.time || '');
  if (kind === DAILY) {
    if (!parseClock(time)) {
      if (!Number.isFinite(at)) { return null; }
      time = fmtClock(at);
    }
    if (!Number.isFinite(at)) { at = nextDailyAt(time, now || Date.now()); }
  }
  if (!Number.isFinite(at) || at <= 0) { return null; }
  return {
    id: String(job.id || newId(now)),
    text: text.slice(0, MAX_TEXT),
    kind: kind,
    at: at,
    time: kind === DAILY ? (parseClock(time) ? fmtClock(clockOnDay(time, at)) : fmtClock(at)) : '',
    enabled: job.enabled !== false,
    /* 展示/执行顺序由用户说了算，不能每次读盘都按 at 重排回去。旧数据没有
     * order，拿 at 当初始值：行为与以前「按时间排序」完全一致，之后上移/下移
     * 才写入真正的顺序号。 */
    order: Number.isFinite(Number(job.order)) ? Number(job.order) : at,
    createdAt: Number(job.createdAt) || (now || Date.now()),
    lastRunAt: Number(job.lastRunAt) || 0,
    lastResult: String(job.lastResult || '')
  };
}

function normalizeJobs(list, now) {
  const src = Array.isArray(list) ? list : [];
  const out = [];
  const seen = Object.create(null);
  src.forEach(function (job) {
    const clean = normalizeJob(job, now);
    if (!clean || seen[clean.id]) { return; }
    seen[clean.id] = true;
    out.push(clean);
  });
  out.sort(function (a, b) { return (a.order - b.order) || (a.at - b.at); });
  return out.slice(0, MAX_JOBS);
}

/** 面板上移/下移：交换后统一编号，normalizeJobs 才能稳定保持这个顺序。 */
function reorderJobs(list, id, delta, now) {
  const jobs = normalizeJobs(list, now);
  const i = jobs.findIndex(function (j) { return j.id === id; });
  const to = i + Number(delta);
  if (i < 0 || to < 0 || to >= jobs.length || !delta) { return jobs; }
  const moved = jobs.splice(i, 1)[0];
  jobs.splice(to, 0, moved);
  jobs.forEach(function (job, index) { job.order = index + 1; });
  return jobs;
}

/** 下一个任务的顺序号：新任务追加到队尾，不插到用户已经调好的顺序里。 */
function nextOrder(list) {
  let max = 0;
  (Array.isArray(list) ? list : []).forEach(function (job) {
    const n = Number(job && job.order);
    if (Number.isFinite(n) && n > max) { max = n; }
  });
  return max + 1;
}

/* 每天任务跑完之后把 at 推到下一次；一次性任务返回 0（调用方负责删掉）。 */
function advance(job, now) {
  if (!job || job.kind !== DAILY) { return 0; }
  const next = nextDailyAt(job.time, now || Date.now());
  job.at = next === null ? 0 : next;
  return job.at;
}

/**
 * 现在该做什么。分成三堆：
 *   run     —— 到点了（或迟到不超过宽限），应当执行
 *   drop    —— 一次性任务，错过太久，直接失效
 *   advance —— 每天任务，错过太久，排到明天（不补跑）
 */
function plan(jobs, now, graceMs) {
  const at = Number.isFinite(now) ? now : Date.now();
  const grace = Number.isFinite(graceMs) ? graceMs : GRACE_MS;
  const out = { run: [], drop: [], advance: [] };
  (Array.isArray(jobs) ? jobs : []).forEach(function (job) {
    if (!job || job.enabled === false) { return; }
    if (!Number.isFinite(job.at) || job.at > at) { return; }
    if (at - job.at <= grace) { out.run.push(job); return; }
    if (job.kind === DAILY) { out.advance.push(job); } else { out.drop.push(job); }
  });
  return out;
}

/** 最近的唤醒时刻（只用于安排 setTimeout，不代表一定会执行）。 */
function nextWakeup(jobs, now) {
  let best = null;
  (Array.isArray(jobs) ? jobs : []).forEach(function (job) {
    if (!job || job.enabled === false) { return; }
    if (!Number.isFinite(job.at)) { return; }
    if (job.at <= now) { return; }   // 已经到期：由 plan() 处理，不必再等
    if (best === null || job.at < best) { best = job.at; }
  });
  return best;
}

function humanizeGap(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) { return days + ' 天' + (hours ? ' ' + hours + ' 小时' : ''); }
  if (hours > 0) { return hours + ' 小时' + (mins ? ' ' + mins + ' 分' : ''); }
  if (mins > 0) { return mins + ' 分钟'; }
  return Math.max(1, total) + ' 秒';
}

/** '今天 02:00' / '明天 02:00' / '11-28 02:00' */
function describeAt(at, now) {
  if (!Number.isFinite(at) || at <= 0) { return '未排定'; }
  const base = Number.isFinite(now) ? now : Date.now();
  const a = new Date(at);
  const b = new Date(base);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const tomorrow = new Date(base);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = a.getFullYear() === tomorrow.getFullYear() &&
    a.getMonth() === tomorrow.getMonth() && a.getDate() === tomorrow.getDate();
  const clock = fmtClock(at);
  if (sameDay) { return '今天 ' + clock; }
  if (isTomorrow) { return '明天 ' + clock; }
  /* 跨年时要带年份：1 月看到「12-31 02:00」会误以为是去年那条。 */
  const year = a.getFullYear() !== b.getFullYear() ? a.getFullYear() + '-' : '';
  return year + pad2(a.getMonth() + 1) + '-' + pad2(a.getDate()) + ' ' + clock;
}

/** '今天 02:00（还有 7 小时 7 分）· 每天' */
function describe(job, now) {
  if (!job) { return ''; }
  const base = Number.isFinite(now) ? now : Date.now();
  const when = describeAt(job.at, base);
  const gap = job.at > base ? '（还有 ' + humanizeGap(job.at - base) + '）' : '（已到期）';
  const repeat = job.kind === DAILY ? '每天' : '仅一次';
  return when + gap + ' · ' + repeat + (job.enabled === false ? ' · 已暂停' : '');
}

function shortText(text, n) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const max = n || 24;
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

module.exports = {
  ONCE,
  DAILY,
  GRACE_MS,
  MAX_JOBS,
  MAX_TEXT,
  parseClock,
  fmtClock,
  clockOnDay,
  nextDailyAt,
  normalizeJob,
  normalizeJobs,
  reorderJobs,
  nextOrder,
  advance,
  plan,
  nextWakeup,
  humanizeGap,
  describeAt,
  describe,
  shortText,
  newId
};
