const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const media = path.join(__dirname, '..', 'media');
const brandSvg = fs.readFileSync(path.join(media, 'icon-brand.svg'));

async function main() {
  await sharp(brandSvg).resize(128, 128).png().toFile(path.join(media, 'icon.png'));
  await sharp(brandSvg).resize(512, 512).png().toFile(path.join(__dirname, '..', 'icon-preview.png'));
  const activitySvg = fs.readFileSync(path.join(media, 'icon.svg'), 'utf8')
    .replace(/currentColor/g, '#2F6FE4');
  const previewDir = path.join(__dirname, '_preview');
  fs.mkdirSync(previewDir, { recursive: true });
  await sharp(Buffer.from(activitySvg)).resize(256, 256).png()
    .toFile(path.join(previewDir, 'activity-16-zoom.png'));
  const meta = await sharp(path.join(media, 'icon.png')).metadata();
  console.log('icon.png:', meta.width + 'x' + meta.height, meta.format, fs.statSync(path.join(media, 'icon.png')).size + ' bytes');
  console.log('icon-preview.png / activity zoom written for visual review');
}
main().catch(e => { console.error(e); process.exit(1); });
