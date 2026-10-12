// Generates square app icons from the official high-res mark (public/brand/caregenicsai-mark-1024.png).
import sharp from 'sharp';
const SRC = 'public/brand/caregenicsai-mark-1024.png';
const BG = { r: 255, g: 255, b: 255, alpha: 1 };
async function icon(size, padRatio, out) {
  const inner = Math.round(size * (1 - 2 * padRatio));
  const mark = await sharp(SRC).trim().resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: mark, gravity: 'center' }]).png().toFile(out);
  console.log('wrote', out);
}
await icon(192, 0.12, 'public/icons/icon-192.png');
await icon(512, 0.12, 'public/icons/icon-512.png');
await icon(512, 0.22, 'public/icons/icon-maskable-512.png'); // safe zone for Android masks
await icon(180, 0.14, 'public/icons/apple-touch-icon.png');
await icon(64, 0.06, 'public/icons/favicon-64.png');
await icon(32, 0.04, 'public/icons/favicon-32.png');
