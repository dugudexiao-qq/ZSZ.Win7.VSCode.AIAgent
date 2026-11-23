'use strict';

/*
 * Zero-dependency file reader for chat context.
 * .docx / .xlsx are ZIP containers, so we read the ZIP central directory with
 * Buffer + zlib.inflateRawSync instead of pulling in an npm package (the Win7
 * host runs Node 16.13.2 and must stay dependency-free).
 *
 * Legacy binary .doc / .xls (OLE2) are deliberately NOT supported: parsing
 * them correctly needs a real library. The error tells the user to re-save.
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;

const TEXT_EXT = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini', '.js', '.ts', '.py', '.css', '.html'];
const ZIP_EXT = { '.docx': 'docx', '.xlsx': 'xlsx' };
const LEGACY_EXT = ['.doc', '.xls'];

function supportedExtensions() {
  return TEXT_EXT.concat(Object.keys(ZIP_EXT));
}

function isSupported(filePath) {
  return supportedExtensions().indexOf(path.extname(String(filePath || '')).toLowerCase()) !== -1;
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
    .replace(/&amp;/g, '&'); // must be last
}

function stripTags(xml) {
  return decodeXmlEntities(String(xml).replace(/<[^>]*>/g, ''));
}

/* Best-effort text decoding. Win7 Chinese text files are often GBK, which is
 * why we fall back to ICU's gbk decoder instead of showing U+FFFD soup. */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), note: 'UTF-16 LE' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return { text: swapped.toString('utf16le'), note: 'UTF-16 BE' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), note: 'UTF-8 BOM' };
  }
  const utf8 = buf.toString('utf8');
  if (/\uFFFD/.test(utf8)) {
    try {
      const TextDecoder = require('util').TextDecoder;
      const guess = new TextDecoder('gbk').decode(buf);
      return { text: guess, note: 'GBK (自动识别)' };
    } catch (e) { /* no ICU gbk support; keep utf8 */ }
  }
  return { text: utf8, note: 'UTF-8' };
}

function findEocd(buf) {
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { return i; }
  }
  return -1;
}

function zipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) { throw new Error('不是有效的 docx/xlsx（ZIP 结构损坏或文件被加密）'); }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) { break; }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  if (entry.localOff + 30 > buf.length || buf.readUInt32LE(entry.localOff) !== 0x04034b50) {
    throw new Error('ZIP 本地头损坏: ' + entry.name);
  }
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) { return raw; }
  if (entry.method === 8) {
    return zlib.inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
  }
  throw new Error('不支持的 ZIP 压缩方式 ' + entry.method + ': ' + entry.name);
}

function docxToText(xml) {
  return decodeXmlEntities(
    String(xml)
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || ''));
  if (!m) { return -1; }
  let n = 0;
  for (let i = 0; i < m[1].length; i++) { n = n * 26 + (m[1].charCodeAt(i) - 64); }
  return n - 1;
}

function csvEscape(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function xlsxToCsv(buf, entries) {
  const shared = [];
  const ss = entries.filter(function (e) { return e.name === 'xl/sharedStrings.xml'; })[0];
  if (ss) {
    const xml = extractEntry(buf, ss).toString('utf8');
    const blocks = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
    blocks.forEach(function (block) {
      const parts = block.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
      shared.push(parts.map(stripTags).join(''));
    });
  }
  const sheets = entries.filter(function (e) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  if (!sheets.length) { throw new Error('xlsx 中找不到工作表'); }

  return sheets.map(function (sheet) {
    const xml = extractEntry(buf, sheet).toString('utf8');
    const rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
    return rows.map(function (row) {
      const cells = [];
      const re = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let m;
      while ((m = re.exec(row)) !== null) {
        const attrs = m[1] || m[3] || '';
        const inner = m[2] || '';
        const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
        const idx = refMatch ? colToIndex(refMatch[1]) : cells.length;
        if (idx < 0 || idx > 512) { continue; }
        const typeMatch = /t="([^"]+)"/.exec(attrs);
        const type = typeMatch ? typeMatch[1] : '';
        const vMatch = /<v>([^<]*)<\/v>/.exec(inner);
        let value = '';
        if (type === 's') {
          value = vMatch ? (shared[Number(vMatch[1])] || '') : '';
        } else if (type === 'inlineStr') {
          value = stripTags(inner);
        } else {
          value = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        }
        cells[idx] = csvEscape(value);
      }
      for (let i = 0; i < cells.length; i++) { if (cells[i] === undefined) { cells[i] = ''; } }
      return cells.join(',');
    }).join('\n');
  }).join('\n\n');
}

function finish(text, kind, note) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  const truncated = clean.length > MAX_TEXT_CHARS;
  return {
    text: clean.slice(0, MAX_TEXT_CHARS) + (truncated ? '\n[...已截断，仅保留前 ' + MAX_TEXT_CHARS + ' 字符]' : ''),
    kind: kind,
    note: note || '',
    chars: Math.min(clean.length, MAX_TEXT_CHARS),
    truncated: truncated
  };
}

/* Returns { text, kind, note, chars, truncated }. Never throws for binary or
 * unsupported plain files - it returns a friendly note instead. */
function readAsText(filePath, opts) {
  const options = opts || {};
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (LEGACY_EXT.indexOf(ext) !== -1) {
    throw new Error('旧版二进制 ' + ext + ' 无法在零依赖环境解析，请用 Word/Excel 另存为 .docx / .xlsx 后再导入。');
  }
  if (!isSupported(filePath)) {
    throw new Error('不支持的文件类型 ' + (ext || '(无扩展名)') + '。支持：' + supportedExtensions().join(' '));
  }
  const stat = fs.statSync(filePath);
  if (stat.size > (options.maxBytes || MAX_INPUT_BYTES)) {
    throw new Error('文件过大（' + stat.size + ' 字节），上限 ' + (options.maxBytes || MAX_INPUT_BYTES) + ' 字节。');
  }
  const buf = fs.readFileSync(filePath);

  if (ZIP_EXT[ext]) {
    const entries = zipEntries(buf);
    if (ZIP_EXT[ext] === 'docx') {
      const doc = entries.filter(function (e) { return e.name === 'word/document.xml'; })[0];
      if (!doc) { throw new Error('docx 中找不到 word/document.xml'); }
      return finish(docxToText(extractEntry(buf, doc).toString('utf8')), 'docx', 'Word 文档纯文本');
    }
    return finish(xlsxToCsv(buf, entries), 'xlsx', 'Excel 工作表 CSV');
  }

  const decoded = decodeText(buf);
  if (decoded.text.indexOf('\u0000') !== -1) {
    throw new Error('看起来是二进制文件，已跳过（请确认扩展名与内容一致）。');
  }
  return finish(decoded.text, ext.replace(/^\./, '') || 'text', decoded.note);
}

module.exports = {
  supportedExtensions: supportedExtensions,
  isSupported: isSupported,
  decodeText: decodeText,
  decodeXmlEntities: decodeXmlEntities,
  zipEntries: zipEntries,
  extractEntry: extractEntry,
  docxToText: docxToText,
  xlsxToCsv: xlsxToCsv,
  csvEscape: csvEscape,
  readAsText: readAsText,
  MAX_TEXT_CHARS: MAX_TEXT_CHARS
};
