// Regenerate the app icons from brand/logo.jpeg.
// The logo ships on a white background; favicons and Android icons get that
// white knocked out (edges stay smooth), while the iOS touch icon keeps it,
// because iOS composites transparent icons onto black.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'brand/logo.jpeg');
const OUT = path.join(root, 'public');
const OPAQUE = 235;      // below this stays fully opaque
const TRANSPARENT = 250; // above this is dropped entirely

// Square the logo on white, then turn white into alpha.
const square = await sharp(SRC)
  .resize(1024, 1024, { fit: 'contain', background: '#ffffff' })
  .png()
  .toBuffer();

const { data, info } = await sharp(square).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 4) {
  const light = Math.min(data[i], data[i + 1], data[i + 2]);
  if (light >= TRANSPARENT) data[i + 3] = 0;
  else if (light > OPAQUE) data[i + 3] = Math.round(255 * (TRANSPARENT - light) / (TRANSPARENT - OPAQUE));
}
const cut = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

const out = (name, buf) => sharp(buf).toFile(path.join(OUT, name)).then(r => console.log(name, r.width + 'x' + r.height, (r.size / 1024).toFixed(1) + ' KB'));
const resize = (buf, size) => sharp(buf).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });

await out('icon-512.png', await resize(cut, 512).png().toBuffer());
await out('icon-192.png', await resize(cut, 192).png().toBuffer());
await out('favicon-32.png', await resize(cut, 32).png().toBuffer());
await out('favicon.webp', await resize(cut, 256).webp({ lossless: true }).toBuffer());
// iOS: keep the white background.
await out('apple-touch-icon.png', await sharp(square).resize(180, 180, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer());
