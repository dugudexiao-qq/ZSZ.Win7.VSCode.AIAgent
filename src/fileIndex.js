'use strict';

/*
 * Workspace file index for the @ mention picker.
 *
 * Why not workspace.findFiles: it answers from the search provider, which on a
 * freshly opened window (and on Win7 / VS Code 1.70) can come back empty or
 * partial, and it silently applies files.exclude / search.exclude, so files the
 * user can see in the explorer never show up in @. The first @ after a reload
 * was therefore a lottery.
 *
 * So we walk the folders ourselves with workspace.fs, breadth first, with a
 * file budget, a directory budget and a deadline. Breadth first keeps shallow
 * files (the ones people reference) ahead of a deep vendor tree, and the fixed
 * skip list only drops the folders nobody wants to @ (node_modules, .git, ...).
 *
 * Pure data in / data out — the vscode objects are injected — so this runs in
 * the offline self-test against a fake tree.
 */

const SKIP_DIRS = {
  'node_modules': 1,
  '.git': 1,
  '.svn': 1,
  '.hg': 1,
  '.agent-selftest': 1
};

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_DIRS = 6000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_DEADLINE_MS = 6000;
const CACHE_TTL_MS = 60000;

/* vscode.FileType */
const FILE = 1;
const DIRECTORY = 2;

function isSkippedDir(name) {
  return !!SKIP_DIRS[String(name === null || name === undefined ? '' : name).toLowerCase()];
}

function byLowerPath(a, b) {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al < bl) { return -1; }
  if (al > bl) { return 1; }
  return 0;
}

/**
 * @param roots        array of folder URIs
 * @param readDirectory (uri) => Promise<[[name, FileType], ...]>
 * @param joinPath      (uri, name) => uri
 * @param options       { maxFiles, maxDirs, maxDepth, deadlineMs, now }
 * @returns { files, truncated, scannedDirs }
 */
async function walkWorkspace(roots, readDirectory, joinPath, options) {
  const opts = options || {};
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  const maxDirs = opts.maxDirs || DEFAULT_MAX_DIRS;
  const maxDepth = opts.maxDepth === undefined ? DEFAULT_MAX_DEPTH : opts.maxDepth;
  const now = opts.now || Date.now;
  const deadline = now() + (opts.deadlineMs || DEFAULT_DEADLINE_MS);

  const out = [];
  const queue = [];
  (roots || []).forEach(function (uri) {
    queue.push({ uri: uri, prefix: '', depth: 0 });
  });

  let scannedDirs = 0;
  let truncated = false;

  while (queue.length) {
    if (out.length >= maxFiles) { truncated = true; break; }
    if (scannedDirs >= maxDirs) { truncated = true; break; }
    if (now() > deadline) { truncated = true; break; }

    const cur = queue.shift();
    let entries = [];
    try { entries = await readDirectory(cur.uri); }
    catch (e) { continue; }          // unreadable folder (permissions, network) — skip it
    scannedDirs += 1;

    const subdirs = [];
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i][0];
      const type = entries[i][1];
      if (type === FILE) {
        out.push(cur.prefix + name);
        if (out.length >= maxFiles) { truncated = true; break; }
      } else if (type === DIRECTORY) {
        if (isSkippedDir(name)) { continue; }
        if (cur.depth + 1 > maxDepth) { truncated = true; continue; }
        subdirs.push({
          uri: joinPath(cur.uri, name),
          prefix: cur.prefix + name + '/',
          depth: cur.depth + 1
        });
      }
    }

    subdirs.sort(function (a, b) { return byLowerPath(a.prefix, b.prefix); });
    for (let j = 0; j < subdirs.length; j++) { queue.push(subdirs[j]); }
  }

  out.sort(byLowerPath);
  return { files: out, truncated: truncated, scannedDirs: scannedDirs };
}

/**
 * vscode-bound wrapper: caches the result for a minute so typing @ does not
 * re-walk the tree on every keystroke, and can be invalidated when folders
 * change.
 */
function createFileIndex(vscode, options) {
  const opts = options || {};
  const ttl = opts.ttlMs || CACHE_TTL_MS;
  let cache = { at: 0, files: [], truncated: false, reason: '' };

  async function collect(force) {
    if (!force && cache.at && (Date.now() - cache.at) < ttl) { return cache; }

    const folders = (vscode.workspace && vscode.workspace.workspaceFolders) || [];
    if (!folders.length) {
      /* 不缓存「没有工作区」：用户紧接着打开文件夹时，下一次 @ 必须立刻看到文件。 */
      cache = { at: 0, files: [], truncated: false, reason: 'no-folder' };
      return cache;
    }

    const result = await walkWorkspace(
      folders.map(function (f) { return f.uri; }),
      function (uri) { return vscode.workspace.fs.readDirectory(uri); },
      function (uri, name) { return vscode.Uri.joinPath(uri, name); },
      opts.walk
    );

    cache = {
      /* 空结果同样不缓存：可能是刚打开窗口、目录还没挂上，下次 @ 重新走一遍。 */
      at: result.files.length ? Date.now() : 0,
      files: result.files,
      truncated: result.truncated,
      reason: result.files.length ? '' : 'empty'
    };
    return cache;
  }

  function invalidate() {
    cache = { at: 0, files: [], truncated: false, reason: '' };
  }

  return { collect: collect, invalidate: invalidate };
}

module.exports = {
  SKIP_DIRS: SKIP_DIRS,
  DEFAULT_MAX_FILES: DEFAULT_MAX_FILES,
  isSkippedDir: isSkippedDir,
  walkWorkspace: walkWorkspace,
  createFileIndex: createFileIndex
};
