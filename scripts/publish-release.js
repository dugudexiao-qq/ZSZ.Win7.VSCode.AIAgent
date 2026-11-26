'use strict';

/*
 * Publish a GitHub-style release on GitCode, with the VSIX attached.
 *
 * GitCode has no "upload asset" endpoint like GitHub's; it hands out a
 * pre-signed object-storage URL and the storage callback registers the file
 * on the release. This script hides that two-step dance.
 *
 *   node scripts/publish-release.js                  current package.json version
 *   node scripts/publish-release.js --tag v1.12.3    one specific tag
 *   node scripts/publish-release.js --backfill       every dist/*.vsix missing on GitCode
 *   node scripts/publish-release.js --force          rewrite an existing release body
 *   node scripts/publish-release.js --dry-run        print the plan, touch nothing
 *
 * Release notes: by default the body of the matching GitHub release is reused
 * (public API, no token needed). --notes <file.md> overrides that, and
 * --no-github-body falls back to the tag name only.
 *
 * Token: GITCODE_TOKEN, else the password already stored for gitcode.com in
 * the git credential helper (the one `git push` uses).
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
const SITE = `https://gitcode.com/${OWNER}/${REPO}`;

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

/* ---- helpers ---- */

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

function token() {
  if (process.env.GITCODE_TOKEN) return process.env.GITCODE_TOKEN.trim();
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=gitcode.com\n\n',
      encoding: 'utf8',
      timeout: 15000
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
    if (line) return line.slice('password='.length).trim();
  } catch (_) {
    /* fall through to the error below */
  }
  fail('没有找到 GitCode 令牌：设置环境变量 GITCODE_TOKEN，或先让 git 记住 gitcode.com 的凭据');
}

const TK = token();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* GitCode throttles per account: 50 calls a minute, and answers 429 with an
 * HTTP 200-looking 500 body for some routes. Retry with a generous pause. */
async function api(pathname, options) {
  const opts = options || {};
  const url = API + pathname;
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
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }
    const throttled =
      res.status === 429 || (data && (data.error_code === 429 || /429 .*too large/i.test(text)));
    if (throttled && attempt < 5) {
      const wait = 20000 * attempt;
      console.log(`    （触发限流，${Math.round(wait / 1000)} 秒后重试 ${attempt}/4）`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const detail = (data && (data.error_msg || data.message || data.error_message || data.error)) || text.slice(0, 200);
      lastError = new Error(`${init.method} ${pathname} → ${res.status} ${detail}`);
      throw lastError;
    }
    return data;
  }
  throw lastError || new Error(`${init.method} ${pathname} → 未知失败`);
}

async function listReleases() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function githubBody(tag) {
  if (!FROM_GITHUB) return null;
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'win7-agent-release' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.body === 'string' && data.body.trim() ? data.body.trim() : null;
}

function localNotes() {
  if (!NOTES_FILE) return null;
  const p = path.resolve(root, NOTES_FILE);
  if (!fs.existsSync(p)) fail(`找不到说明文件：${NOTES_FILE}`);
  return fs.readFileSync(p, 'utf8').trim();
}

function vsixFor(version) {
  const name = `zsz-win7-vscode-aiagent-${version}.vsix`;
  const candidates = [path.join(root, 'dist', name), path.join(root, name)];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function footer(version) {
  return [
    '',
    '---',
    '',
    '## 安装',
    '',
    `1. 在下方「发行版附件」里下载 \`zsz-win7-vscode-aiagent-${version}.vsix\``,
    '2. `code --install-extension zsz-win7-vscode-aiagent-' + version + '.vsix`，或在 VS Code 里执行 *Extensions: Install from VSIX…*',
    '3. 重载窗口：*Developer: Reload Window*',
    '',
    `MIT 开源 · 源码镜像：[GitCode](${SITE}) · 问题反馈：[Issues](${SITE}/issues)`
  ].join('\n');
}

async function buildBody(tag) {
  const version = tag.replace(/^v/, '');
  const explicit = localNotes();
  const gh = explicit ? null : await githubBody(tag);
  const head = explicit || gh || `v${version}`;
  return head + footer(version);
}

async function uploadAsset(tag, file) {
  const name = path.basename(file);
  const info = await api(
    `/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`
  );
  if (!info || !info.url) throw new Error('GitCode 没有返回上传地址');
  const headers = Object.assign({}, info.headers || {});
  const res = await fetch(info.url, {
    method: 'PUT',
    headers,
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
async function dropDeadAssets(tag, file) {
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
async function verifyAsset(tag, file) {
  const name = path.basename(file);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    const assets = (rel && rel.assets) || [];
    const hit = assets.find((a) => a.name === name && typeof a.size === 'number' && a.size > 0);
    if (hit) return hit;
    if (attempt < 6) await sleep(5000);
  }
  return null;
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

  console.log(`GitCode 发行版：${OWNER}/${REPO}`);
  console.log(`计划处理 ${targets.length} 个版本${DRY ? '（演练，不写入）' : ''}\n`);

  const existing = await listReleases();
  const byTag = new Map(existing.map((r) => [r.tag_name, r]));

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const tag of targets) {
    const version = tag.replace(/^v/, '');
    const file = vsixFor(version);
    const rel = byTag.get(tag);

    if (!file) {
      console.log(`- ${tag}  跳过：dist/ 里没有 ${version} 的 vsix`);
      skipped++;
      continue;
    }

    const size = fs.statSync(file).size;
    try {
      if (rel && !FORCE) {
        const asset = await verifyAsset(tag, file);
        if (asset) {
          console.log(`- ${tag}  已存在（附件 ${Math.round(size / 1024)} KB）`);
          skipped++;
          continue;
        }
        console.log(`- ${tag}  发行版已存在但缺附件，补传`);
        if (!DRY) {
          await dropDeadAssets(tag, file);
          await uploadAsset(tag, file);
        }
        if (!DRY && !(await verifyAsset(tag, file))) throw new Error('上传后仍查不到附件');
        created++;
        continue;
      }

      const body = await buildBody(tag);
      if (DRY) {
        const verb = rel ? '将更新正文并补传附件' : '将创建';
        console.log(`- ${tag}  ${verb}，正文 ${body.length} 字，附件 ${Math.round(size / 1024)} KB`);
        created++;
        continue;
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
      await uploadAsset(tag, file);
      if (!(await verifyAsset(tag, file))) throw new Error('上传后仍查不到附件');
      console.log(`- ${tag}  已发布，附件 ${Math.round(size / 1024)} KB`);
      created++;
    } catch (err) {
      failed++;
      console.log(`- ${tag}  失败：${err.message}`);
    } finally {
      if (!DRY) await sleep(1500);
    }
  }

  console.log(`\n完成：新发布 ${created}，跳过 ${skipped}，失败 ${failed}`);
  if (failed) process.exit(1);
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
