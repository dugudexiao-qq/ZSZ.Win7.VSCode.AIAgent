'use strict';

/*
 * Normalize an OpenAI-compatible endpoint typed by a human.
 * Pure logic: no vscode, no network, safe to unit-test offline.
 *
 * Accepted input                     -> result
 *   "192.168.1.20:8080"              -> http://192.168.1.20:8080/v1
 *   "192.168.1.20:8080/ollama/v1"    -> http://192.168.1.20:8080/ollama/v1
 *   "http://host:1234/v1"            -> unchanged
 *   "https://host/v1"                -> unchanged
 *   "8080"                           -> port changed on CURRENT host/path ONLY
 *                                      when a current address is already set;
 *                                      otherwise rejected (no built-in default)
 *
 * The extension ships with NO address and NO port. A path is required because
 * llmClient appends /chat/completions to baseUrl; when the user gives only
 * host:port we add /v1 (the de facto OpenAI prefix).
 */

const URLCtor = require('url').URL;

function parseCurrent(current) {
  try {
    const u = new URLCtor(String(current || '').trim());
    if (!u.hostname) { return null; }
    return u;
  } catch (e) { return null; }
}

function normalizeEndpoint(input, current) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) { return { ok: false, error: '地址不能为空' }; }

  let candidate = raw;
  const notes = [];

  if (/^\d{1,5}$/.test(raw)) {
    const port = Number(raw);
    if (port < 1 || port > 65535) { return { ok: false, error: '端口必须是 1-65535 的整数' }; }
    const base = parseCurrent(current);
    if (!base) {
      return { ok: false, error: '扩展不内置地址或端口。请先填写完整地址（例如 http://主机:端口/v1），之后才能只改端口。' };
    }
    base.port = String(port);
    candidate = base.toString();
    notes.push('只改端口，主机沿用 ' + base.hostname);
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = 'http://' + candidate;
    notes.push('已补 http://');
  }

  let u;
  try { u = new URLCtor(candidate); }
  catch (e) { return { ok: false, error: '不是合法地址：' + raw }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '只支持 http:// 或 https://（当前是 ' + u.protocol + '）' };
  }
  if (!u.hostname) { return { ok: false, error: '地址里缺少主机名或 IP' }; }
  if (u.username || u.password) { return { ok: false, error: '地址里不要带用户名/密码' }; }
  if (u.search || u.hash) { return { ok: false, error: '地址里不要带查询串或 # 片段' }; }
  if (!u.pathname || u.pathname === '/') {
    u.pathname = '/v1';
    notes.push('已补 /v1');
  }

  const value = u.toString().replace(/\/+$/, '');
  return {
    ok: true,
    value: value,
    note: notes.join('；'),
    host: u.hostname,
    port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    path: u.pathname
  };
}

function shortEndpoint(value) {
  try {
    const u = new URLCtor(String(value));
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch (e) { return String(value || ''); }
}

module.exports = { normalizeEndpoint, shortEndpoint };
