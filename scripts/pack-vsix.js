'use strict';

/*
 * Zero-dependency VSIX packer.
 *
 * vsce needs npm and network; the target machines have neither. A VSIX is
 * just a ZIP with [Content_Types].xml, extension.vsixmanifest and an
 * extension/ folder, so we build it by hand with zlib + a CRC32 table.
 *
 * Run: node scripts/pack-vsix.js
 * Out: zsz-win7-vscode-aiagent-<version>.vsix
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/* ---- CRC32 ---- */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}());

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time, date: date };
}

function zip(entries) {
  const now = new Date();
  const stamp = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(function (e) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);           // UTF-8 names
    lh.writeUInt16LE(8, 8);                 // deflate
    lh.writeUInt16LE(stamp.time, 10);
    lh.writeUInt16LE(stamp.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(stamp.time, 12);
    ch.writeUInt16LE(stamp.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  });

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/* ---- which files go in ----
 * Mirrors .vscodeignore: no scripts, no node_modules, no ui-preview, no vsix. */
function collect() {
  const out = [];
  function add(rel, name) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) { return; }
    out.push({ name: name || 'extension/' + rel.replace(/\\/g, '/'), data: fs.readFileSync(full) });
  }
  function addDir(rel, filter) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) { return; }
    fs.readdirSync(dir).sort().forEach(function (f) {
      const sub = rel + '/' + f;
      if (fs.statSync(path.join(root, sub)).isDirectory()) { addDir(sub, filter); return; }
      if (filter && !filter(f)) { return; }
      add(sub);
    });
  }

  add('package.json');
  add('README.md', 'extension/readme.md');
  add('LICENSE', 'extension/LICENSE.txt');
  add('extension.js');
  addDir('src', function (f) { return /\.js$/.test(f); });
  addDir('media', function (f) { return /\.(js|css|png|svg)$/.test(f); });
  return out;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildManifest() {
  const p = manifest;
  const author = p.author && p.author.name ? p.author.name : String(p.author || '');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '\t<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">\n' +
    '\t\t<Metadata>\n' +
    '\t\t\t<Identity Language="en-US" Id="' + xmlEscape(p.name) + '" Version="' + xmlEscape(p.version) + '" Publisher="' + xmlEscape(p.publisher) + '" />\n' +
    '\t\t\t<DisplayName>' + xmlEscape(p.displayName) + '</DisplayName>\n' +
    '\t\t\t<Description xml:space="preserve">' + xmlEscape(p.description) + '</Description>\n' +
    '\t\t\t<Tags>' + xmlEscape((p.keywords || []).join(',')) + '</Tags>\n' +
    '\t\t\t<Categories>' + xmlEscape((p.categories || []).join(',')) + '</Categories>\n' +
    '\t\t\t<GalleryFlags>Public</GalleryFlags>\n' +
    '\t\t\t<Properties>\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + xmlEscape(p.engines.vscode) + '" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />\n' +
    '\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>\n' +
    '\t\t\t</Properties>\n' +
    '\t\t\t<License>extension/LICENSE.txt</License>\n' +
    '\t\t\t<Icon>' + xmlEscape(p.icon ? 'extension/' + p.icon.replace(/\\/g, '/') : 'extension/media/icon.png') + '</Icon>\n' +
    '\t\t\t<Author>' + xmlEscape(author) + '</Author>\n' +
    '\t\t</Metadata>\n' +
    '\t\t<Installation>\n' +
    '\t\t\t<InstallationTarget Id="Microsoft.VisualStudio.Code"/>\n' +
    '\t\t</Installation>\n' +
    '\t\t<Dependencies/>\n' +
    '\t\t<Assets>\n' +
    '\t\t\t<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />\n' +
    '\t\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />\n' +
    '\t\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />\n' +
    '\t\t\t<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="' + xmlEscape(p.icon ? 'extension/' + p.icon.replace(/\\/g, '/') : 'extension/media/icon.png') + '" Addressable="true" />\n' +
    '\t\t</Assets>\n' +
    '\t</PackageManifest>';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension=".json" ContentType="application/json"/>' +
  '<Default Extension=".vsixmanifest" ContentType="text/xml"/>' +
  '<Default Extension=".md" ContentType="text/markdown"/>' +
  '<Default Extension=".txt" ContentType="text/plain"/>' +
  '<Default Extension=".js" ContentType="application/javascript"/>' +
  '<Default Extension=".svg" ContentType="image/svg+xml"/>' +
  '<Default Extension=".png" ContentType="image/png"/>' +
  '<Default Extension=".css" ContentType="text/css"/>' +
  '</Types>';

function main() {
  const files = collect();
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(buildManifest(), 'utf8') }
  ].concat(files);

  const buf = zip(entries);
  const outName = 'zsz-win7-vscode-aiagent-' + manifest.version + '.vsix';
  const outFile = path.join(root, outName);
  fs.writeFileSync(outFile, buf);

  console.log('packed ' + outName);
  console.log('  files: ' + entries.length + ' (extension/: ' + files.length + ')');
  console.log('  size : ' + (buf.length / 1024).toFixed(2) + ' KB');
  files.forEach(function (f) { console.log('    ' + f.name + '  ' + f.data.length); });
  remindDist(outName);
  return outFile;
}

/* dist/ 里只留最新一版给 GitCode 镜像页下载（.gitignore 用具体文件名白名单），
 * 忘了改就会「本地有包、仓库里还是上一版」，国内用户下到的永远是旧版。 */
function remindDist(outName) {
  const ignoreFile = path.join(root, '.gitignore');
  try {
    const text = fs.readFileSync(ignoreFile, 'utf8');
    if (text.indexOf('!dist/' + outName) === -1) {
      console.log('  NOTE: .gitignore still whitelists the previous dist file.');
      console.log('        cp ' + outName + ' dist/ && update the "!dist/..." line');
    }
  } catch (e) { /* 没有 .gitignore 就没什么可提醒的 */ }
}

if (require.main === module) { main(); }
module.exports = { main: main, zip: zip, crc32: crc32 };
