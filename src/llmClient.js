'use strict';

/*
 * HTTP client for OpenAI-compatible /chat/completions.
 * Pure Node.js built-ins only. Target runtime: Node 16.13.2 (VS Code 1.70.x).
 * Node bundles its own OpenSSL + root CAs, so this does NOT depend on WinHTTP /
 * Schannel TLS 1.2 registry flags on Windows 7.
 */

const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const URLCtor = require('url').URL;
const pathUtils = require('./pathUtils');

const MAX_ERROR_BODY = 4096;

function CancelledError() {
  const err = new Error('Cancelled');
  err.name = 'CancelledError';
  err.cancelled = true;
  return err;
}

function createSseDecoder() {
  let buffer = '';
  return {
    push: function (chunk) {
      buffer += String(chunk).replace(/\r\n/g, '\n');
      const events = [];
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parts = [];
        block.split('\n').forEach(function (line) {
          if (line.indexOf('data:') !== 0) { return; }
          let value = line.slice(5);
          if (value.charAt(0) === ' ') { value = value.slice(1); }
          parts.push(value);
        });
        if (parts.length) { events.push(parts.join('\n')); }
        idx = buffer.indexOf('\n\n');
      }
      return events;
    },
    flush: function () {
      const rest = buffer.trim();
      buffer = '';
      if (rest.indexOf('data:') === 0) {
        let value = rest.slice(5);
        if (value.charAt(0) === ' ') { value = value.slice(1); }
        return [value];
      }
      return [];
    }
  };
}

/* Only real reasoning fields are surfaced. If the endpoint does not send one,
 * the UI shows nothing - we never fabricate a chain of thought. */
function extractReasoning(delta) {
  if (!delta || typeof delta !== 'object') { return ''; }
  const keys = ['reasoning_content', 'reasoning', 'thinking', 'thought'];
  for (let i = 0; i < keys.length; i++) {
    if (typeof delta[keys[i]] === 'string' && delta[keys[i]]) { return delta[keys[i]]; }
  }
  return '';
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function buildRequestOptions(params) {
  const config = params.config;
  const base = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('未设置模型服务地址。本扩展不内置地址或端口，请先运行命令「设置服务地址 / 端口」，或在 win7Agent.baseUrl 填入完整地址（例如 http://主机:端口/v1）。');
  }
  const endpoint = new URLCtor(base + params.pathSuffix);
  const isHttps = endpoint.protocol === 'https:';
  if (!isHttps && endpoint.protocol !== 'http:') {
    throw new Error('Unsupported protocol: ' + endpoint.protocol + '. Use http:// for an intranet relay or https:// for a cloud API.');
  }
  const payload = params.payload || '';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': params.stream ? 'text/event-stream' : 'application/json',
    'User-Agent': 'zsz-win7-vscode-aiagent/0.3'
  };
  // Local llama.cpp / Ollama / LM Studio servers usually ignore auth. Sending a
  // bogus "Bearer undefined" header confuses some of them, so omit it entirely.
  if (params.apiKey) { headers['Authorization'] = 'Bearer ' + params.apiKey; }
  if (payload) { headers['Content-Length'] = Buffer.byteLength(payload); }

  const options = {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port || (isHttps ? 443 : 80),
    path: endpoint.pathname + endpoint.search,
    method: payload ? 'POST' : 'GET',
    headers: headers,
    timeout: params.timeoutMs || 1000000,
    agent: false
  };

  if (isHttps && config.extraCaFile) {
    const extra = fs.readFileSync(config.extraCaFile, 'utf8');
    // Keep Node's built-in roots, then append the corporate/self-signed CA.
    options.ca = tls.rootCertificates.concat([extra]);
  }
  return { options: options, isHttps: isHttps, payload: payload };
}

function openTunnel(proxyUrl, hostname, port) {
  return new Promise(function (resolve, reject) {
    let proxy;
    try { proxy = new URLCtor(proxyUrl); } catch (e) {
      reject(new Error('Invalid http.proxy setting: ' + proxyUrl));
      return;
    }
    const headers = { Host: hostname + ':' + port };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password || '');
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    }
    const req = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: hostname + ':' + port,
      headers: headers,
      timeout: 10000
    });
    req.on('connect', function (res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('Proxy CONNECT failed with HTTP ' + res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', function () { req.destroy(new Error('ETIMEDOUT: proxy CONNECT timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function createTunnelAgent(proxyUrl, fallbackHost, fallbackPort) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (opts, callback) {
    const host = opts.host || fallbackHost;
    const port = opts.port || fallbackPort;
    openTunnel(proxyUrl, host, port).then(function (socket) {
      const secure = tls.connect({
        socket: socket,
        servername: opts.servername || host,
        ca: opts.ca
      });
      secure.once('secureConnect', function () { callback(null, secure); });
      secure.once('error', function (err) { callback(err); });
    }).catch(function (err) { callback(err); });
  };
  return agent;
}

function makeHttpError(status, body) {
  const err = new Error('HTTP ' + status + ': ' + pathUtils.truncate(body, 300));
  err.status = status;
  err.body = body;
  return err;
}

function classifyError(err, config) {
  if (!err) { return 'Unknown error'; }
  if (err.cancelled || err.name === 'CancelledError') { return 'Cancelled.'; }
  const code = String(err.code || '');
  const msg = String(err.message || err);
  const combined = code + ' ' + msg;
  const local = config && config.localEndpoint;

  if (/CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID/i.test(combined)) {
    return 'TLS certificate validation failed (' + (code || 'certificate') + '). Node uses its own root CA store, not the Windows one. For a corporate MITM proxy or a self-signed intranet relay, put the root CA PEM in win7Agent.extraCaFile. Do NOT disable certificate verification.';
  }
  if (/ERR_SSL|EPROTO|Ciphers|wrong version number/i.test(combined)) {
    return 'TLS handshake failed: ' + msg + '. Check that the endpoint supports TLS 1.2+ and that a transparent proxy is not downgrading the connection.';
  }
  if (err.status === 401 || err.status === 403) {
    return 'Authentication failed (HTTP ' + err.status + '). ' + (local ? 'Local model servers usually need no key - either remove the stored key or check the server\'s auth setting.' : 'Check the API key with the "Set API Key" command.') + ' ' + pathUtils.truncate(err.body || '', 160);
  }
  if (err.status === 404) {
    return 'Endpoint not found (HTTP 404). Check win7Agent.baseUrl - most servers need a /v1 suffix and the model name must match the server alias.';
  }
  if (err.status === 429) {
    return 'Rate limited (HTTP 429). Wait and retry, or check your quota.';
  }
  if (err.status >= 500) {
    return 'Upstream server error (HTTP ' + err.status + '). ' + pathUtils.truncate(err.body || '', 160);
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|Proxy CONNECT/i.test(combined)) {
    if (local && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up/i.test(combined)) {
      return 'Cannot reach the local model server (' + msg + '). Check that llama-server / Ollama / LM Studio is running, that win7Agent.baseUrl uses the right host and port, and that the GGUF has finished loading. The default timeout is 1000 s - the progress bar shows elapsed time while waiting.';
    }
    return 'Network problem: ' + msg + '. If this machine needs an outbound proxy, set VS Code\'s http.proxy setting (https://user:pass@host:port).';
  }
  if (err.status) {
    return 'HTTP ' + err.status + ': ' + pathUtils.truncate(err.body || msg, 200);
  }
  return msg + ' (run the "Diagnose Connection" command for details)';
}

function performRequest(params) {
  const built = buildRequestOptions(params);
  const options = built.options;
  const transport = built.isHttps ? https : http;

  if (built.isHttps && params.config.proxy) {
    options.agent = createTunnelAgent(params.config.proxy, options.hostname, options.port);
  }

  return new Promise(function (resolve, reject) {
    let cancelSub = null;
    let settled = false;
    let wallTimer = null;
    function finish(err, value) {
      if (settled) { return; }
      settled = true;
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (cancelSub && typeof cancelSub.dispose === 'function') { cancelSub.dispose(); }
      if (err) { reject(err); } else { resolve(value); }
    }

    let req;
    try {
      req = transport.request(options, function (res) {
        const status = res.statusCode || 0;
        const isSse = /text\/event-stream/i.test(String(res.headers['content-type'] || ''));
        res.setEncoding('utf8');

        if (status < 200 || status >= 300) {
          let body = '';
          res.on('data', function (chunk) {
            if (body.length < MAX_ERROR_BODY) { body += chunk; }
          });
          res.on('end', function () { finish(makeHttpError(status, body)); });
          return;
        }

        if (isSse && params.onChunk) {
          const decoder = createSseDecoder();
          res.on('data', function (chunk) {
            decoder.push(chunk).forEach(params.onChunk);
          });
          res.on('end', function () {
            decoder.flush().forEach(params.onChunk);
            finish(null, { status: status, stream: true, text: '' });
          });
          return;
        }

        let text = '';
        res.on('data', function (chunk) { text += chunk; });
        res.on('end', function () { finish(null, { status: status, stream: false, text: text }); });
      });
    } catch (e) {
      finish(e);
      return;
    }

    // options.timeout in Node is an INACTIVITY timeout. A slow-but-alive stream
    // would never hit it, so add a hard wall-clock deadline as well.
    if (options.timeout > 0 && options.timeout < 2147483647) {
      wallTimer = setTimeout(function () {
        req.destroy(new Error('ETIMEDOUT: total request time exceeded ' + options.timeout + ' ms'));
      }, options.timeout);
    }
    req.on('timeout', function () {
      req.destroy(new Error('ETIMEDOUT: no data for ' + options.timeout + ' ms'));
    });
    req.on('error', function (err) { finish(err); });

    if (params.token) {
      if (params.token.isCancellationRequested) {
        req.destroy(CancelledError());
        return;
      }
      if (typeof params.token.onCancellationRequested === 'function') {
        cancelSub = params.token.onCancellationRequested(function () {
          req.destroy(CancelledError());
        });
      }
    }

    if (built.payload) { req.write(built.payload); }
    req.end();
  });
}

/* Transient failures only. ETIMEDOUT is deliberately NOT retried: the wall
 * clock is set to the user's chat timeout (1000 s by default), so retrying
 * would make a dead server hang the run twice as long. Nothing is retried once
 * text has been shown, otherwise the user would see the same words twice. */
const RETRY_DELAYS = [1000, 3000];

function isRetryableError(err) {
  if (!err || err.cancelled || err.name === 'CancelledError') { return false; }
  const status = Number(err.status || 0);
  if (status === 429) { return true; }
  if (status >= 500 && status <= 599) { return true; }
  if (!status) {
    const text = String(err.code || '') + ' ' + String(err.message || '');
    return /ECONNRESET|EPIPE|ECONNABORTED|EAI_AGAIN|socket hang up/i.test(text);
  }
  return false;
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function shortReason(err) {
  if (err && err.status) { return 'HTTP ' + err.status; }
  if (err && err.code) { return String(err.code); }
  return '连接中断';
}

async function chatCompletion(params) {
  const config = params.config;
  const apiKey = params.apiKey;
  const stream = Boolean(params.stream);
  const onDelta = typeof params.onDelta === 'function' ? params.onDelta : function () {};
  const onThought = typeof params.onThought === 'function' ? params.onThought : function () {};
  const onRetry = typeof params.onRetry === 'function' ? params.onRetry : function () {};

  const body = {
    model: config.model,
    messages: params.messages,
    stream: stream
  };
  if (params.maxTokens) { body.max_tokens = params.maxTokens; }

  for (let attempt = 0; ; attempt++) {
    const full = { text: '', thinking: '', emitted: false };
    try {
      const result = await performRequest({
        config: config,
        apiKey: apiKey,
        pathSuffix: '/chat/completions',
        payload: JSON.stringify(body),
        stream: stream,
        timeoutMs: params.timeoutMs || config.timeoutMs,
        token: params.token,
        onChunk: function (data) {
          if (data === '[DONE]') { return; }
          const json = safeParse(data);
          if (!json || !json.choices || !json.choices.length) { return; }
          const choice = json.choices[0];
          const delta = choice.delta || choice.message || {};
          const piece = typeof delta.content === 'string' ? delta.content : '';
          if (piece) { full.text += piece; full.emitted = true; onDelta(piece); }
          const thought = extractReasoning(delta);
          if (thought) { full.thinking += thought; full.emitted = true; onThought(thought); }
        }
      });

      if (!result.stream) {
        const json = safeParse(result.text);
        let text = '';
        if (json && json.choices && json.choices.length) {
          const msg = json.choices[0].message || {};
          text = typeof msg.content === 'string' ? msg.content : '';
          const thought = extractReasoning(msg);
          if (thought) { full.thinking += thought; onThought(thought); }
        }
        if (!text && !full.thinking) {
          if (params.allowEmpty) { return { content: '', thinking: '', streamed: false }; }
          throw new Error('Empty or unrecognized response from /chat/completions. Raw: ' + pathUtils.truncate(result.text, 300));
        }
        full.text = text;
        if (text) { onDelta(text); }
      }
      return { content: full.text, thinking: full.thinking, streamed: result.stream };
    } catch (e) {
      const delay = RETRY_DELAYS[attempt];
      const cancelled = params.token && params.token.isCancellationRequested;
      if (delay === undefined || cancelled || !isRetryableError(e) || full.emitted) { throw e; }
      onRetry(shortReason(e) + '，' + Math.round(delay / 1000) + ' 秒后自动重试（第 ' +
        (attempt + 1) + ' / ' + RETRY_DELAYS.length + ' 次）');
      await sleep(delay);
    }
  }
}

async function checkConnection(params) {
  try {
    // Diagnostics deliberately use a short timeout, independent of the
    // (very long) chat timeout, so a dead endpoint fails fast.
    const res = await chatCompletion({
      config: params.config,
      apiKey: params.apiKey,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      maxTokens: 1,
      allowEmpty: true,
      timeoutMs: params.timeoutMs || 15000,
      onDelta: function () {},
      onThought: function () {}
    });
    return { ok: true, detail: 'HTTP OK, model ' + params.config.model + ' accepted the request (' + res.content.length + ' chars returned).' };
  } catch (e) {
    return { ok: false, detail: classifyError(e, params.config) };
  }
}

function isLocalEndpoint(baseUrl) {
  try {
    const u = new URLCtor(String(baseUrl || ''));
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0') { return true; }
    if (/^10\./.test(h) || /^192\.168\./.test(h)) { return true; }
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) { return true; }
    if (/\.local$/i.test(h) || /\.internal$/i.test(h)) { return true; }
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = {
  createSseDecoder,
  buildRequestOptions,
  isLocalEndpoint,
  classifyError,
  extractReasoning,
  chatCompletion,
  checkConnection,
  CancelledError
};
