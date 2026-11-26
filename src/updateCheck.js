'use strict';

/*
 * 版本更新检查（v1.12.3）
 *
 * 内网/离线环境里，扩展不一定从官方 GitHub 下载；有的团队自建镜像，有的把
 * 安装包放在内部文件服务器上。所以「去哪查最新版」必须可配：
 *
 *   win7Agent.updateRepo 支持两种写法
 *     1. "owner/repo"                → 走 GitHub Releases API（默认官方仓库）
 *     2. "https://example.com/f.json" → 走自定义 feed（内网镜像自己托管）
 *
 * feed 只是一个 JSON，字段尽量宽松，下面三种都认：
 *   { "version": "1.12.3", "url": "https://…/x.vsix", "notes": "…" }
 *   { "tag_name": "v1.12.3", "html_url": "…", "body": "…" }     ← GitHub 原样
 *   { "latest": { "version": "1.12.3" }, "releases": [ … ] }     ← 折中写法
 *
 * 本模块只做「解析 + 比较 + 决定要不要提醒」，网络请求也在这里，但 http
 * 客户端可注入，方便离线自测（不联网也能覆盖全部判断）。
 */

const DEFAULT_REPO = 'dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent';
/* 一天查一次就够：版本不会一分钟一变，而每次启动都请求会拖慢冷启动，
 * 内网代理下还可能卡住。手动「检查更新」不受这个节流限制。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 2;

/**
 * 解析用户填的地址。
 * 返回 null（空/无法识别）或
 *   { kind: 'github', owner, repo, label }
 *   { kind: 'feed', url, label }
 */
function parseRepo(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) { return null; }

  /* owner/repo：两段，允许 .git 后缀与首尾斜杠 */
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    const parts = raw.split('/');
    const repo = parts[1].replace(/\.git$/i, '');
    return { kind: 'github', owner: parts[0], repo: repo, label: parts[0] + '/' + repo };
  }

  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    /* 直接粘仓库主页（很多人的习惯）：识别成 GitHub API 查询 */
    const gh = /^(?:www\.)?github\.com$/i.test(u.hostname);
    if (gh) {
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length >= 2) {
        return { kind: 'github', owner: seg[0], repo: seg[1].replace(/\.git$/i, ''), label: seg[0] + '/' + seg[1] };
      }
      return null;
    }
    /* 其余一律当自定义 feed。查询串保留（内部服务器常用 ?token=…）。 */
    return { kind: 'feed', url: u.toString(), label: u.host + u.pathname };
  }

  return null;
}

/* GitHub API 的请求描述；feed 直接复用原 URL。 */
function buildRequest(target) {
  if (!target) { return null; }
  if (target.kind === 'github') {
    return {
      hostname: 'api.github.com',
      path: '/repos/' + encodeURIComponent(target.owner) + '/' + encodeURIComponent(target.repo) + '/releases/latest',
      headers: {
        'User-Agent': 'zsz-win7-agent-update-check',
        Accept: 'application/vnd.github+json'
      }
    };
  }
  const u = new URL(target.url);
  return {
    hostname: u.hostname,
    path: u.pathname + (u.search || ''),
    port: u.port || undefined,
    protocol: u.protocol,
    headers: { 'User-Agent': 'zsz-win7-agent-update-check', Accept: 'application/json' }
  };
}

/* 版本号 → 数字数组。'v1.12.2' / '1.12.2' / '1.12.2-beta.1' 都认；
 * 非法返回 null（宁可不提醒，也不要拿垃圾数据比较） */
function parseVersion(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().replace(/^v/i, '');
  const m = /^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) { return null; }
  const nums = m[1].split('.').map(function (x) { return Number(x); });
  while (nums.length < 3) { nums.push(0); }
  return { nums: nums, pre: m[2] || '' };
}

/** a > b → 1，a < b → -1，相等（含无法比较）→ 0 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) { return 0; }
  for (let i = 0; i < Math.max(va.nums.length, vb.nums.length); i++) {
    const x = va.nums[i] || 0;
    const y = vb.nums[i] || 0;
    if (x !== y) { return x > y ? 1 : -1; }
  }
  /* 正式版 > 预发布版：1.2.0 比 1.2.0-beta 新 */
  if (va.pre === vb.pre) { return 0; }
  if (!va.pre) { return 1; }
  if (!vb.pre) { return -1; }
  return va.pre > vb.pre ? 1 : -1;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

/* 从 release / feed 的 JSON 里抽出版本号、下载页和更新说明。
 * 字段名放宽，是因为用户可能把 GitHub 响应原样转发，也可能自己写个小 JSON。 */
function extractRelease(json) {
  const data = json && typeof json === 'object' ? json : {};
  const pick = function (obj) {
    if (!obj || typeof obj !== 'object') { return null; }
    const version = obj.version || obj.tag_name || obj.tag || obj.latest_version || '';
    if (!version) { return null; }
    /* 顺序很重要：GitHub 的 `url` 是 api.github.com 的接口地址，点开是一坨
     * JSON；`html_url` 才是人看的发布页。拿不到发布页时留空，让调用方退回
     * 「仓库的 releases 页」，而不是把 API 地址甩给用户。 */
    let url = String(obj.html_url || obj.download_url || obj.page || obj.url || '');
    if (/^https?:\/\/api\.github\.com\/repos\//i.test(url)) { url = ''; }
    return {
      version: String(version).trim().replace(/^v/i, ''),
      url: url,
      notes: String(obj.notes || obj.body || obj.changelog || '')
    };
  };
  const direct = pick(data);
  if (direct) { return direct; }
  if (data.latest && typeof data.latest === 'object') {
    const nested = pick(data.latest);
    if (nested) { return nested; }
  }
  const list = data.releases || data.items;
  if (Array.isArray(list)) {
    /* 取版本号最大的那条，而不是数组第一项：feed 的作者未必排序 */
    let best = null;
    list.forEach(function (item) {
      const one = pick(item);
      if (!one) { return; }
      if (!best || compareVersions(one.version, best.version) > 0) { best = one; }
    });
    if (best) { return best; }
  }
  return null;
}

/* 该不该查：手动永远查；自动要满足「开关开着 + 距上次超过 24 小时」。 */
function shouldCheck(opts) {
  const o = opts || {};
  if (o.manual) { return true; }
  if (o.enabled === false) { return false; }
  const last = Number(o.lastCheckAt) || 0;
  const now = Number(o.now) || Date.now();
  if (!last) { return true; }
  if (last > now) { return true; }   /* 时钟被拨回：别卡住，查一次 */
  return (now - last) >= (Number(o.intervalMs) || CHECK_INTERVAL_MS);
}

/* 要不要弹提醒：比当前新，且不是用户点过「跳过此版本」的那个版本。 */
function shouldNotify(latest, current, skipped) {
  if (!latest) { return false; }
  if (!isNewer(latest, current)) { return false; }
  return String(skipped || '') !== String(latest);
}

/* ---- 网络 ---- */

function httpGet(req, opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) || REQUEST_TIMEOUT_MS;
  const protocol = req.protocol === 'http:' ? require('http') : require('https');
  return new Promise(function (resolve, reject) {
    let settled = false;
    let guard = null;
    let r = null;
    const finish = function (err, value) {
      if (settled) { return; }
      settled = true;
      if (guard) { clearTimeout(guard); guard = null; }
      if (err) { reject(err); } else { resolve(value); }
    };
    /* r.setTimeout 只管「连接建立之后」。内网/断网时 DNS 解析本身就可能挂很久，
     * 所以再加一道墙钟兜底，保证一次检查最多占用这么久。 */
    guard = setTimeout(function () {
      finish(new Error('更新源 ' + Math.round(timeoutMs / 1000) + ' 秒内没有响应'));
      if (r) { try { r.destroy(); } catch (e) { /* 已经结束 */ } }
    }, timeoutMs + 2000);
    r = protocol.request({
      hostname: req.hostname,
      path: req.path,
      port: req.port,
      method: 'GET',
      headers: req.headers
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && o.redirects > 0) {
        res.resume();
        let next;
        try {
          const u = new URL(res.headers.location, (req.protocol || 'https:') + '//' + req.hostname);
          next = { hostname: u.hostname, path: u.pathname + (u.search || ''), port: u.port || undefined, protocol: u.protocol, headers: req.headers };
        } catch (e) { finish(new Error('更新源返回了无法解析的跳转地址')); return; }
        httpGet(next, Object.assign({}, o, { redirects: (o.redirects || MAX_REDIRECTS) - 1 })).then(
          function (v) { finish(null, v); }, function (e) { finish(e); });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error('更新源返回 HTTP ' + res.statusCode +
          (res.statusCode === 404 ? '（仓库或 feed 地址不对，或还没有发布任何版本）' : '')));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) {
        buf += c;
        if (buf.length > 512 * 1024) { r.destroy(new Error('更新源返回内容过大')); }
      });
      res.on('end', function () { finish(null, buf); });
    });
    r.on('error', function (e) { finish(e); });
    r.setTimeout(timeoutMs, function () {
      r.destroy(new Error('更新源 ' + Math.round(timeoutMs / 1000) + ' 秒内没有响应'));
    });
    r.end();
  });
}

/**
 * 查一次最新版本。不抛异常：失败时返回 { ok:false, error }，调用方决定是
 * 弹窗（手动）还是只写日志（自动）。
 * @param {string} input  win7Agent.updateRepo 的值
 * @param {object} opts   { timeoutMs, get: (req, opts) => Promise<string> }
 */
async function checkLatest(input, opts) {
  const o = opts || {};
  const target = parseRepo(input || DEFAULT_REPO);
  if (!target) {
    return { ok: false, error: '更新源地址无法识别：' + String(input || '') +
      '（可填 owner/repo，或一个返回 JSON 的 https 地址）' };
  }
  const request = buildRequest(target);
  const get = typeof o.get === 'function' ? o.get : httpGet;
  let body;
  try {
    body = await get(request, { timeoutMs: o.timeoutMs });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e), target: target };
  }
  let json;
  try { json = JSON.parse(body); }
  catch (e) {
    return { ok: false, error: '更新源返回的不是 JSON（开头是：' + String(body || '').slice(0, 60) + '）', target: target };
  }
  const release = extractRelease(json);
  if (!release) {
    return { ok: false, error: '更新源里没有版本号（需要 version 或 tag_name 字段）', target: target };
  }
  return { ok: true, latest: release, target: target };
}

module.exports = {
  DEFAULT_REPO,
  CHECK_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  parseRepo,
  buildRequest,
  parseVersion,
  compareVersions,
  isNewer,
  extractRelease,
  shouldCheck,
  shouldNotify,
  checkLatest
};
