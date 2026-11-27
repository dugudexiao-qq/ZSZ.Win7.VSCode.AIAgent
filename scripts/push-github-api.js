'use strict';

/*
 * Push local commits to GitHub through the Git Data API.
 *
 * The GitHub git transport is occasionally unusable from the machines this
 * extension is built on (schannel / proxy 502), while api.github.com still
 * works. Rebuild each missing commit from its tree instead of pushing a pack.
 *
 *   node scripts/push-github-api.js          push every commit after the remote tip
 *   node scripts/push-github-api.js --dry-run
 *
 * Tokens: GITHUB_TOKEN, else the password git already has stored for github.com.
 */

const { execFileSync } = require('child_process');

const ROOT = require('path').resolve(__dirname, '..');
const REPO = process.env.GH_REPO || 'dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent';
const API = 'https://api.github.com/repos/' + REPO;
const DRY = process.argv.includes('--dry-run');

function git(args, options) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, maxBuffer: 128 * 1024 * 1024 }, options || {}));
}

function token() {
  if (process.env.GITHUB_TOKEN) { return process.env.GITHUB_TOKEN.trim(); }
  const out = git(['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
  if (!line) { throw new Error('no GitHub token: set GITHUB_TOKEN or let git remember github.com'); }
  return line.slice('password='.length).trim();
}

const TK = token();

async function api(path, method, body) {
  const res = await fetch(API + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + TK,
      'User-Agent': 'win7-agent',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(method + ' ' + path + ' -> ' + res.status + ': ' + JSON.stringify(data));
  }
  return data;
}

function subject(sha) {
  return git(['show', '-s', '--format=%s', sha], { encoding: 'utf8' }).trim();
}

function metadata(sha) {
  const raw = git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha], { encoding: 'utf8' });
  const parts = raw.split('\0');
  return {
    message: parts.slice(6).join('\0').replace(/\s+$/, '') + '\n',
    author: { name: parts[0], email: parts[1], date: parts[2] },
    committer: { name: parts[3], email: parts[4], date: parts[5] }
  };
}

function changes(sha) {
  const raw = git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha], { encoding: 'utf8' });
  return raw.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
}

function fileMode(treeSha, path) {
  const out = git(['ls-tree', treeSha, '--', path], { encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/)[0] : '100644';
}

async function main() {
  const ref = await api('/git/ref/heads/main');
  let parentSha = ref.object.sha;
  const remoteCommit = await api('/git/commits/' + parentSha);
  const remoteSubject = String(remoteCommit.message || '').split(/\r?\n/)[0];

  const local = git(['rev-list', '--reverse', 'HEAD'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const start = local.findIndex((sha) => subject(sha) === remoteSubject);
  if (start < 0) {
    throw new Error('remote tip "' + remoteSubject + '" is not in local history; cannot replay safely');
  }
  const localTree = git(['rev-parse', local[start] + '^{tree}'], { encoding: 'utf8' }).trim();
  if (localTree !== remoteCommit.tree.sha) {
    throw new Error('tree mismatch at "' + remoteSubject + '": remote ' + remoteCommit.tree.sha + ' local ' + localTree);
  }

  const pending = local.slice(start + 1);
  if (!pending.length) {
    console.log('GitHub is already up to date (' + parentSha.slice(0, 8) + ')');
    return;
  }
  console.log('replaying ' + pending.length + ' commit(s) onto ' + parentSha.slice(0, 8));
  let baseTree = remoteCommit.tree.sha;

  for (const sha of pending) {
    if (DRY) { console.log('  [dry] ' + sha.slice(0, 8) + ' ' + subject(sha)); continue; }
    const meta = metadata(sha);
    const parentTree = git(['rev-parse', sha + '^^{tree}'], { encoding: 'utf8' }).trim();
    const entries = [];
    for (const row of changes(sha)) {
      const status = row[0];
      const path = row[1];
      if (status[0] === 'D') {
        entries.push({ path: path, mode: fileMode(parentTree, path), sha: null });
      } else if (status[0] === 'R' || status[0] === 'C') {
        entries.push({ path: path, mode: fileMode(parentTree, path), sha: null });
      }
      if (status[0] === 'R' || status[0] === 'C') {
        const target = row[2];
        const blob = git(['show', sha + ':' + target], { maxBuffer: 128 * 1024 * 1024 });
        const created = await api('/git/blobs', 'POST', { content: blob.toString('base64'), encoding: 'base64' });
        entries.push({ path: target, mode: fileMode(git(['rev-parse', sha + '^{tree}'], { encoding: 'utf8' }).trim(), target), sha: created.sha });
      } else if (status[0] !== 'D') {
        const blob = git(['show', sha + ':' + path], { maxBuffer: 128 * 1024 * 1024 });
        const created = await api('/git/blobs', 'POST', { content: blob.toString('base64'), encoding: 'base64' });
        entries.push({ path: path, mode: fileMode(git(['rev-parse', sha + '^{tree}'], { encoding: 'utf8' }).trim(), path), sha: created.sha });
      }
    }
    const tree = await api('/git/trees', 'POST', { base_tree: baseTree, tree: entries });
    const commit = await api('/git/commits', 'POST', {
      message: meta.message,
      tree: tree.sha,
      parents: [parentSha],
      author: meta.author,
      committer: meta.committer
    });
    parentSha = commit.sha;
    baseTree = tree.sha;
    console.log('  ' + sha.slice(0, 8) + ' -> ' + commit.sha.slice(0, 8) + ' ' + subject(sha));
  }

  if (!DRY) {
    await api('/git/refs/heads/main', 'PATCH', { sha: parentSha, force: false });
    console.log('main -> ' + parentSha);
  }
}

main().catch((e) => {
  console.error('GitHub API push failed: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
