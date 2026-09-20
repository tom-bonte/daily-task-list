// Menu bar glyph: a black silhouette of the logo with an alpha channel, which
// macOS recolours for light/dark menu bars (isTemplate).
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'brand/logo.jpeg');
const OUT = path.join(root, 'menubar/Resources');

for (const [name, size] of [['menubar.png', 18], ['menubar@2x.png', 36], ['menubar@3x.png', 54]]) {
  const { data, info } = await sharp(SRC)
    .resize(size, size, { fit: 'contain', background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < data.length; i++) {
    // Darker pixels become more opaque; the white background disappears.
    rgba[i * 4 + 3] = Math.min(255, Math.round((255 - data[i]) * 2.1));
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(path.join(OUT, name));
  console.log(name, `${size}x${size}`);
}
