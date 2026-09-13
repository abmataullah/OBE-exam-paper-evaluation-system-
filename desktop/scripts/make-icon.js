/**
 * Generates resources/icon.png (256x256) with zero dependencies: a blue
 * rounded square with a white "grading sheet" glyph. electron-builder
 * converts it to .ico for Windows automatically.
 *
 * Usage: node scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// Rounded square background (#1d4ed8)
const R = 48;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, R), SIZE - 1 - R);
    const cy = Math.min(Math.max(y, R), SIZE - 1 - R);
    const d = Math.hypot(x - cx, y - cy);
    if (d <= R) set(x, y, 0x1d, 0x4e, 0xd8);
  }
}

// White "sheet" rectangle with three horizontal lines + a check mark
function rect(x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b);
}
rect(64, 48, 192, 208, 255, 255, 255);          // sheet
rect(84, 76, 172, 86, 0x1d, 0x4e, 0xd8);        // line 1
rect(84, 104, 172, 114, 0x1d, 0x4e, 0xd8);      // line 2
rect(84, 132, 140, 142, 0x1d, 0x4e, 0xd8);      // line 3 (short)
// check mark (green) bottom-right of sheet
for (let t = 0; t < 26; t++) { for (let w = 0; w < 10; w++) set(126 + t, 170 + t - w, 0x16, 0xa3, 0x4a); }
for (let t = 0; t < 46; t++) { for (let w = 0; w < 10; w++) set(150 + t, 194 - t - w, 0x16, 0xa3, 0x4a); }

// --- PNG encode ---
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('Wrote', out, `(${png.length} bytes)`);
