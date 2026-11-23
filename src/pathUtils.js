'use strict';

const path = require('path');

function isPathInside(root, target) {
  if (!root || !target) { return false; }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, String(target));
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (path.isAbsolute(rel)) { return false; }
  if (rel === '..' || rel.indexOf('..' + path.sep) === 0) { return false; }
  return true;
}

function truncate(text, maxChars) {
  const value = String(text === undefined || text === null ? '' : text);
  const limit = Number(maxChars) || 12000;
  if (value.length <= limit) { return value; }
  return value.slice(0, limit) + '\n[...truncated ' + (value.length - limit) + ' chars]';
}

/* Keep the head AND the tail. A source file's first lines carry imports and
 * declarations, its last lines carry the closing structure; cutting only the
 * tail told a small model nothing about how the file ends. 70/30 split keeps
 * the beginning readable and still shows where the file stops. */
function truncateMiddle(text, maxChars) {
  const value = String(text === undefined || text === null ? '' : text);
  const limit = Number(maxChars) || 4000;
  if (value.length <= limit) { return value; }
  const marker = '\n[...truncated ';
  const tailLen = Math.max(200, Math.floor(limit * 0.3));
  const headLen = Math.max(200, limit - tailLen - 40);
  const dropped = value.length - headLen - tailLen;
  return value.slice(0, headLen) + marker + dropped + ' chars...]\n' + value.slice(value.length - tailLen);
}

module.exports = { isPathInside, truncate, truncateMiddle };
