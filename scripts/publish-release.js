'use strict';

/*
 * Publish one version to both release pages, with the VSIX attached.
 *
 * The two hosts disagree on nearly everything:
 *   GitHub  POST /releases, then POST uploads.github.com/.../assets
 *   GitCode POST /releases, then GET /releases/{tag}/upload_url and PUT the
 *           bytes to a pre-signed object-storage URL (its callback registers
 *           the attachment), and it throttles at 50 calls/minute.
 * Both are hidden behind one command so a release can no longer land on one
 * side only.
 *
 *   node scripts/publish-release.js                  current package.json version
 *   node scripts/publish-release.js --tag v1.12.3    one specific tag
 *   node scripts/publish-release.js --backfill       every dist/*.vsix missing somewhere
 *   node scripts/publish-release.js --force          rewrite an existing release body
 *   node scripts/publish-release.js --dry-run        print the plan, touch nothing
 *   node scripts/publish-release.js --notes a.md     use this text as the release body
 *   node scripts/publish-release.js --hosts gitcode  restrict to one host
 *
 * Tokens: GITCODE_TOKEN / GITHUB_TOKEN, else whatever `git push` already has
 * stored for each host in the git credential helper.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const OWNER = process.env.GITCODE_OWNER || 'dugudexiao';
const REPO = process.env.GITCODE_REPO || 'zsz.Win7.AIAgent';
const API = 'https://api.gitcode.com/api/v5';
const GH_REPO = process.env.GH_REPO || 'dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent';
const GH_API = 'https://api.github.com/repos/' + GH_REPO;
const GH_UPLOADS = 'https://uploads.github.com/repos/' + GH_REPO;
const SITE = `https://gitcode.com/${OWNER}/${REPO}`;
const GH_SITE = `https://github.com/${GH_REPO}`;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const DRY = has('--dry-run');
const FORCE = has('--force');
const BACKFILL = has('--backfill');
const TAG = valueOf('--tag');
const NOTES_FILE = valueOf('--notes');
const FROM_GITHUB = !has('--no-github-body');
const HOSTS = (valueOf('--hosts') || 'gitcode,github')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter((h) => h === 'gitcode' || h === 'github');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

/* ---- tokens ---- */

function gitCredential(host) {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8',
      timeout: 15000
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
    return line ? line.slice('password='.length).trim() : null;
  } catch (_) {
    return null;
  }
}

function token(envName, host, label) {
  if (process.env[envName]) return process.env[envName].trim();
  const saved = gitCredential(host);
  if (saved) return saved;
  fail(`没有找到 ${label} 令牌：设置环境变量 ${envName}，或先让 git 记住 ${host} 的凭据`);
}

const TK = HOSTS.includes('gitcode')
  ? token('GITCODE_TOKEN', 'gitcode.com', 'GitCode')
  : null;
const GHTK = HOSTS.includes('github')
  ? token('GITHUB_TOKEN', 'github.com', 'GitHub')
  : null;

/* ---- shared helpers ---- */

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

function localNotes() {
  if (!NOTES_FILE) return null;
  const p = path.resolve(root, NOTES_FILE);
  if (!fs.existsSync(p)) fail(`找不到说明文件：${NOTES_FILE}`);
  return fs.readFileSync(p, 'utf8').trim();
}

const NOTES = localNotes();

/* Our own footer is appended below the real notes. When a body is reused from
 * the other host it already carries one — strip it so we do not stack them. */
function stripFooter(body) {
  const text = String(body || '').trim();
  const i = text.lastIndexOf('\n---\n\n## 安装');
  return i > 0 ? text.slice(0, i).trim() : text;
}

function footer(version, host) {
  const site = host === 'github' ? GH_SITE : SITE;
  return [
    '',
    '---',
    '',
    '## 安装',
    '',
    `1. 在下方「发行版附件」里下载 \`zsz-win7-vscode-aiagent-${version}.vsix\``,
    `2. \`code --install-extension zsz-win7-vscode-aiagent-${version}.vsix\`，或在 VS Code 里执行 *Extensions: Install from VSIX…*`,
    '3. 重载窗口：*Developer: Reload Window*',
    '',
    `MIT 开源 · 源码：[${host === 'github' ? 'GitHub' : 'GitCode'}](${site})` +
      ` · 国内镜像：[GitCode](${SITE}) · 问题反馈：[Issues](${site}/issues)`
  ].join('\n');
}

function vsixFor(version) {
  const name = `zsz-win7-vscode-aiagent-${version}.vsix`;
  const candidates = [path.join(root, 'dist', name), path.join(root, name)];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ---- GitCode ---- */

/* GitCode throttles per account: 50 calls a minute, and answers 429 with an
 * HTTP 200-looking 500 body for some routes. Retry with a generous pause. */
async function api(pathname, options) {
  const opts = options || {};
  const init = {
    method: opts.method || 'GET',
    headers: { 'PRIVATE-TOKEN': TK, Accept: 'application/json' }
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(API + pathname, init);
    const data = await readJson(res);
    const text = JSON.stringify(data || '');
    const throttled =
      res.status === 429 || (data && (data.error_code === 429 || /429 .*too large/i.test(text)));
    if (throttled && attempt < 5) {
      const wait = 20000 * attempt;
      console.log(`    （GitCode 限流，${Math.round(wait / 1000)} 秒后重试 ${attempt}/4）`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const detail =
        (data && (data.error_msg || data.message || data.error_message || data.error)) ||
        String(text).slice(0, 200);
      lastError = new Error(`${init.method} ${pathname} → ${res.status} ${detail}`);
      throw lastError;
    }
    return data;
  }
  throw lastError || new Error(`${init.method} ${pathname} → 未知失败`);
}

async function gcList() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function gcBody(tag) {
  if (!FROM_GITHUB) return null;
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'win7-agent-release' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.body === 'string' && data.body.trim() ? stripFooter(data.body) : null;
}

function gcBodyFor(tag, ghExisting) {
  const version = tag.replace(/^v/, '');
  const head = NOTES || (ghExisting ? stripFooter(ghExisting) : null) || `v${version}`;
  return head + footer(version, 'gitcode');
}

async function gcUpload(tag, file) {
  const name = path.basename(file);
  const info = await api(
    `/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`
  );
  if (!info || !info.url) throw new Error('GitCode 没有返回上传地址');
  const res = await fetch(info.url, {
    method: 'PUT',
    headers: Object.assign({}, info.headers || {}),
    body: fs.readFileSync(file),
    duplex: 'half'
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`上传 ${name} 失败：HTTP ${res.status} ${t.slice(0, 200)}`);
  }
}

/* A release created while GitCode was throttling can end up with a placeholder
 * attachment (size=null) whose upload callback never lands. Deleting the dead
 * entry first is what makes the next upload take. */
async function gcDropDeadAssets(tag, file) {
  const name = path.basename(file);
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const dead = ((rel && rel.assets) || []).filter(
    (a) => a.type === 'attach' && a.name === name && !(typeof a.size === 'number' && a.size > 0)
  );
  for (const asset of dead) {
    await api(`/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}/attach_files/${asset.id}`, {
      method: 'DELETE'
    });
    console.log(`    （清掉一条空附件 ${asset.id}）`);
  }
  return dead.length;
}

/* An attachment shows up in `assets` as soon as the PUT starts, but with
 * size=null until the storage callback finishes. Only a sized entry counts. */
async function gcVerify(tag, file) {
  const name = path.basename(file);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    const hit = ((rel && rel.assets) || []).find(
      (a) => a.name === name && typeof a.size === 'number' && a.size > 0
    );
    if (hit) return hit;
    if (attempt < 6) await sleep(5000);
  }
  return null;
}

/* GitCode keeps a single "latest" badge, and PATCHing a release without
 * release_status clears it. Set it explicitly on the newest version. */
async function gcMarkLatest(tag) {
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  if (rel && rel.release_status === 'latest') return false;
  await api(`/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}`, {
    method: 'PATCH',
    body: {
      tag_name: tag,
      name: (rel && rel.name) || `ZSZ Win7 AI Agent ${tag}`,
      body: (rel && rel.body) || tag,
      release_status: 'latest',
      make_latest: 'true'
    }
  });
  return true;
}

async function publishGitcode(tag, file, ctx) {
  const version = tag.replace(/^v/, '');
  const size = Math.round(fs.statSync(file).size / 1024);
  const rel = ctx.gcByTag.get(tag);

  if (rel && !FORCE) {
    const asset = await gcVerify(tag, file);
    if (asset) {
      console.log(`- ${tag}  GitCode 已存在（附件 ${size} KB）`);
      return 'skipped';
    }
    console.log(`- ${tag}  GitCode 发行版已存在但缺附件，补传`);
    if (!DRY) {
      await gcDropDeadAssets(tag, file);
      await gcUpload(tag, file);
      if (!(await gcVerify(tag, file))) throw new Error('GitCode 上传后仍查不到附件');
    }
    return DRY ? 'would' : 'created';
  }

  const body = gcBodyFor(tag, ctx.ghByTag.get(tag));
  if (DRY) {
    console.log(`- ${tag}  GitCode ${rel ? '将更新正文并补传附件' : '将创建'}，正文 ${body.length} 字，附件 ${size} KB`);
    return 'would';
  }
  if (rel && FORCE) {
    await api(`/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}`, {
      method: 'PATCH',
      body: { tag_name: tag, name: `ZSZ Win7 AI Agent ${tag}`, body }
    });
  } else {
    await api(`/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag,
        target_commitish: 'main',
        name: `ZSZ Win7 AI Agent ${tag}`,
        body,
        prerelease: false
      }
    });
  }
  await gcUpload(tag, file);
  if (!(await gcVerify(tag, file))) throw new Error('GitCode 上传后仍查不到附件');
  console.log(`- ${tag}  GitCode 已发布，附件 ${size} KB`);
  return 'created';
}

/* ---- GitHub ---- */

async function ghFetch(url, options) {
  const opts = options || {};
  const init = {
    method: opts.method || 'GET',
    headers: Object.assign(
      {
        Authorization: 'Bearer ' + GHTK,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'win7-agent-release'
      },
      opts.headers || {}
    )
  };
  if (opts.body !== undefined) init.body = opts.body;
  const res = await fetch(url, init);
  const data = await readJson(res);
  if (!res.ok) {
    const detail = (data && (data.message || data.error)) || JSON.stringify(data).slice(0, 200);
    throw new Error(`${init.method} ${url.replace(GH_API, '')} → ${res.status} ${detail}`);
  }
  return data;
}

async function ghList() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await ghFetch(`${GH_API}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function ghBodyFor(tag, existing) {
  const version = tag.replace(/^v/, '');
  const head = NOTES || (existing ? stripFooter(existing.body) : null) || `v${version}`;
  return head + footer(version, 'github');
}

function ghHasAsset(rel, file) {
  const name = path.basename(file);
  return ((rel && rel.assets) || []).some(
    (a) => a.name === name && typeof a.size === 'number' && a.size > 0
  );
}

async function ghUpload(rel, file) {
  const name = path.basename(file);
  const res = await fetch(`${GH_UPLOADS}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + GHTK,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'win7-agent-release',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fs.statSync(file).size)
    },
    body: fs.readFileSync(file),
    duplex: 'half'
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(`GitHub 上传 ${name} 失败：HTTP ${res.status} ${(data && data.message) || ''}`);
  }
  return data;
}

async function ghReload(tag) {
  const res = await fetch(`${GH_API}/releases/tags/${tag}`, {
    headers: {
      Authorization: 'Bearer ' + GHTK,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'win7-agent-release'
    }
  });
  if (!res.ok) return null;
  return res.json();
}

async function publishGithub(tag, file, ctx) {
  const size = Math.round(fs.statSync(file).size / 1024);
  const rel = ctx.ghByTag.get(tag);

  if (rel && !FORCE) {
    if (ghHasAsset(rel, file)) {
      console.log(`- ${tag}  GitHub 已存在（附件 ${size} KB）`);
      return 'skipped';
    }
    console.log(`- ${tag}  GitHub 发行版已存在但缺附件，补传`);
    if (!DRY) await ghUpload(rel, file);
    return DRY ? 'would' : 'created';
  }

  const body = ghBodyFor(tag, rel);
  if (DRY) {
    console.log(`- ${tag}  GitHub ${rel ? '将更新正文' : '将创建'}，正文 ${body.length} 字，附件 ${size} KB`);
    return 'would';
  }

  let release = rel;
  if (rel && FORCE) {
    release = await ghFetch(`${GH_API}/releases/${rel.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ZSZ Win7 AI Agent ${tag}`, body, prerelease: false })
    });
  } else {
    release = await ghFetch(`${GH_API}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `ZSZ Win7 AI Agent ${tag}`,
        body,
        prerelease: false
      })
    });
  }
  if (!ghHasAsset(release, file)) await ghUpload(release, file);
  const check = await ghReload(tag);
  if (!ghHasAsset(check, file)) throw new Error('GitHub 上传后仍查不到附件');
  console.log(`- ${tag}  GitHub 已发布，附件 ${size} KB`);
  return 'created';
}

/* ---- planning ---- */

function targetVersions() {
  if (TAG) return [TAG];
  if (BACKFILL) {
    const dir = path.join(root, 'dist');
    if (!fs.existsSync(dir)) fail('dist/ 不存在，先跑 node scripts/pack-vsix.js');
    return fs
      .readdirSync(dir)
      .map((f) => /^zsz-win7-vscode-aiagent-(.+)\.vsix$/.exec(f))
      .filter(Boolean)
      .map((m) => 'v' + m[1]);
  }
  return ['v' + manifest.version];
}

function sortVersions(list) {
  const key = (v) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  return list.slice().sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/* ---- main ---- */

(async function main() {
  const targets = sortVersions(targetVersions());
  if (targets.length === 0) fail('没有找到要发布的版本');

  console.log('发布到：' + HOSTS.join(' + '));
  console.log(`计划处理 ${targets.length} 个版本${DRY ? '（演练，不写入）' : ''}\n`);

  const ctx = { gcByTag: new Map(), ghByTag: new Map() };
  if (HOSTS.includes('gitcode')) {
    (await gcList()).forEach((r) => ctx.gcByTag.set(r.tag_name, r));
  }
  if (HOSTS.includes('github')) {
    (await ghList()).forEach((r) => ctx.ghByTag.set(r.tag_name, r));
  }

  const tally = { created: 0, skipped: 0, failed: 0 };

  for (const tag of targets) {
    const version = tag.replace(/^v/, '');
    const file = vsixFor(version);
    if (!file) {
      console.log(`- ${tag}  跳过：dist/ 里没有 ${version} 的 vsix`);
      tally.skipped++;
      continue;
    }

    let tagFailed = false;
    for (const host of HOSTS) {
      try {
        const state = host === 'gitcode'
          ? await publishGitcode(tag, file, ctx)
          : await publishGithub(tag, file, ctx);
        if (state === 'skipped' || state === 'would') tally.skipped++;
        else tally.created++;
      } catch (err) {
        tagFailed = true;
        tally.failed++;
        console.log(`- ${tag}  ${host === 'gitcode' ? 'GitCode' : 'GitHub'} 失败：${err.message}`);
      }
      if (!DRY) await sleep(1200);
    }
    if (tagFailed) console.log(`- ${tag}  这一版没有全部成功，别的版本继续`);
  }

  if (!DRY && HOSTS.includes('gitcode')) {
    const newest = targets[targets.length - 1];
    try {
      if (await gcMarkLatest(newest)) console.log(`- ${newest}  已标为 GitCode 最新发行版`);
    } catch (err) {
      console.log(`- ${newest}  标「最新」失败：${err.message}`);
    }
  }

  console.log(`\n完成：新发布 ${tally.created}，跳过 ${tally.skipped}，失败 ${tally.failed}`);
  if (tally.failed) process.exit(1);
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
