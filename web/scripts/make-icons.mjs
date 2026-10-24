// Builds the favicons, the Apple touch icon and the web manifest's icons from the logo
// (web/brand/logo.jpg, which is not shipped) into web/public/. Run after changing the logo:
//
//   node web/scripts/make-icons.mjs
//
// The logo is a red envelope in a dashed frame on off-white. Small sizes (16–48 px) use the
// envelope alone, because the dashed frame turns to noise there; the larger icons use the whole
// logo. The maskable icon keeps the logo inside the central safe circle (40 % radius) that
// launchers never crop. favicon.ico holds PNG images, which every current browser reads.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const web = join(import.meta.dirname, '..');
const src = join(web, 'brand', 'logo.jpg');
const out = (name) => join(web, 'public', name);
const BG = { r: 246, g: 242, b: 233, alpha: 1 }; // the logo's own background, #f6f2e9

// Measured on the 497×424 source: the whole logo (frame included), and the envelope inside it.
const WHOLE = { left: 73, top: 48, width: 361, height: 321 };
const ENVELOPE = { left: 100, top: 72, width: 310, height: 272 };

const squared = (box) => sharp(src).extract(box)
  .resize(512, 512, { fit: 'contain', background: BG }).png().toBuffer();
const png = (input, size) => sharp(input).resize(size, size).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
// The logo at `scale` of the canvas, centred on the background colour.
const padded = async (input, size, scale) => {
  const inner = Math.round(size * scale);
  const logo = await sharp(input).resize(inner, inner).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'centre' }]).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
};

const whole = await squared(WHOLE);
const envelope = await squared(ENVELOPE);

const files = {
  'favicon-32.png': await png(envelope, 32),
  'apple-touch-icon.png': await padded(whole, 180, 0.88), // iOS rounds the corners itself
  'icon-192.png': await padded(whole, 192, 0.92),
  'icon-512.png': await padded(whole, 512, 0.92),
  'icon-maskable-192.png': await padded(whole, 192, 0.56), // a square of side 0.56 fits the 0.8 circle
  'icon-maskable-512.png': await padded(whole, 512, 0.56),
};

// ICO: a 6-byte header, a 16-byte entry per image, then the PNGs themselves.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((s) => png(envelope, s)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s, e); // width
  header.writeUInt8(s, e + 1); // height
  header.writeUInt8(0, e + 2); // no palette
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); // planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
files['favicon.ico'] = Buffer.concat([header, ...images]);

for (const [name, data] of Object.entries(files)) {
  writeFileSync(out(name), data);
  console.log(`${name}: ${(data.length / 1024).toFixed(1)} KB`);
}
