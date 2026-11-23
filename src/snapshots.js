'use strict';

/*
 * Per-round write snapshots. Every successful saveText / createFile first
 * records what the target path looked like BEFORE the write (content or
 * "did not exist"). The host collects these records for the run and keeps the
 * most recent rounds in memory; the panel can then revert one round's file
 * changes with a single click — restore old content, or delete created files.
 *
 * Snapshots live in memory only (file contents can be large and stale copies
 * in globalState would be a hazard after restarts). A revert is one-shot: the
 * entry is dropped after restoring so the same snapshot cannot be applied twice.
 */

const fs = require('fs');
const path = require('path');

/* Refuse to snapshot absurdly large files into memory. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_FILES_PER_RUN = 50;

/* Read the pre-write state of one workspace-relative path. Called right
 * before fs.writeFileSync, AFTER the user approved the write, so a rejected
 * write never leaves a stale snapshot behind. */
function captureBefore(fullPath, rel) {
  try {
    if (!fs.existsSync(fullPath)) {
      return { rel: String(rel || ''), existed: false, content: null };
    }
    const st = fs.statSync(fullPath);
    if (!st.isFile()) { return null; }
    if (st.size > MAX_SNAPSHOT_BYTES) {
      return { rel: String(rel || ''), existed: true, content: null, tooLarge: true, size: st.size };
    }
    return { rel: String(rel || ''), existed: true, content: fs.readFileSync(fullPath, 'utf8'), size: st.size };
  } catch (e) {
    /* A file we cannot read we also cannot restore; skip it. */
    return null;
  }
}

/* Push a record into the run's snapshot list (shared by sub-agents). */
function record(list, rec) {
  if (!Array.isArray(list) || !rec) { return; }
  if (list.length >= MAX_FILES_PER_RUN) { return; }
  list.push(rec);
}

/* Restore every file in the snapshot. Returns per-file results for reporting.
 * Files created during the round (existed=false) are deleted; overwritten
 * files get their old bytes back. Missing-at-revert files are reported. */
function revert(root, records) {
  const results = [];
  const list = Array.isArray(records) ? records : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    const rel = String(rec.rel || '');
    const full = path.resolve(root, rel);
    /* Path sanity: never touch anything outside the workspace root, even if a
     * record was tampered with. */
    if (root && path.resolve(full).indexOf(path.resolve(root)) !== 0) {
      results.push({ rel: rel, ok: false, reason: '路径不在工作区内，已跳过' });
      continue;
    }
    try {
      if (!rec.existed) {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full);
          results.push({ rel: rel, ok: true, action: 'deleted' });
        } else {
          results.push({ rel: rel, ok: true, action: 'already-gone' });
        }
      } else if (rec.tooLarge) {
        results.push({ rel: rel, ok: false, reason: '原文件过大（' + rec.size + ' 字节），无法自动恢复' });
      } else if (rec.content === null || rec.content === undefined) {
        results.push({ rel: rel, ok: false, reason: '原内容未知，无法恢复' });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, rec.content, 'utf8');
        results.push({ rel: rel, ok: true, action: 'restored' });
      }
    } catch (e) {
      results.push({ rel: rel, ok: false, reason: e && e.message ? e.message : String(e) });
    }
  }
  return results;
}

function describeFiles(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map(function (r) {
    return r.rel + (r.existed ? '' : '（新建）');
  });
}

module.exports = {
  captureBefore,
  record,
  revert,
  describeFiles,
  MAX_SNAPSHOT_BYTES,
  MAX_FILES_PER_RUN
};
