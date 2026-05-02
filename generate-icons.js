// Generate KITT-themed app icons:
// - Dark rounded-square background
// - Glowing red horizontal scanner bar in the center
// - Inner highlight + soft outer glow
const fs = require('fs');
const zlib = require('zlib');

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePNG(size, drawFn) {
  const px = Buffer.alloc(size * size * 4);
  drawFn(px, size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// --- Drawing helpers ---
function setPx(px, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // Alpha blending over existing pixel
  const dstA = px[i + 3] / 255;
  const srcA = a / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  px[i]     = Math.round((r * srcA + px[i]     * dstA * (1 - srcA)) / outA);
  px[i + 1] = Math.round((g * srcA + px[i + 1] * dstA * (1 - srcA)) / outA);
  px[i + 2] = Math.round((b * srcA + px[i + 2] * dstA * (1 - srcA)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function drawRoundedRect(px, size, x0, y0, x1, y1, r, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Find distance to nearest corner
      let dx = 0, dy = 0;
      if (x < x0 + r) dx = x0 + r - x;
      else if (x > x1 - r - 1) dx = x - (x1 - r - 1);
      if (y < y0 + r) dy = y0 + r - y;
      else if (y > y1 - r - 1) dy = y - (y1 - r - 1);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= r) {
        const aa = dist > r - 1 ? Math.max(0, r - dist) : 1;
        setPx(px, size, x, y, color[0], color[1], color[2], color[3] * aa);
      }
    }
  }
}

function drawAppIcon(px, size) {
  const inset = Math.round(size * 0.05);
  const x0 = inset, y0 = inset;
  const x1 = size - inset, y1 = size - inset;
  const radius = Math.round(size * 0.22);

  // 1. Dark rounded background with subtle gradient
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let dx = 0, dy = 0;
      if (x < x0 + radius) dx = x0 + radius - x;
      else if (x > x1 - radius - 1) dx = x - (x1 - radius - 1);
      if (y < y0 + radius) dy = y0 + radius - y;
      else if (y > y1 - radius - 1) dy = y - (y1 - radius - 1);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        const aa = dist > radius - 1 ? Math.max(0, radius - dist) : 1;
        // Vertical gradient from dark to slightly lighter
        const t = (y - y0) / (y1 - y0);
        const base = Math.round(8 + t * 16);
        setPx(px, size, x, y, base, base, base + 4, 255 * aa);
      }
    }
  }

  // 2. Inner top highlight (glass shimmer)
  for (let y = y0 + 2; y < y0 + Math.round(size * 0.3); y++) {
    for (let x = x0 + 2; x < x1 - 2; x++) {
      let dx = 0, dy = 0;
      if (x < x0 + radius) dx = x0 + radius - x;
      else if (x > x1 - radius - 1) dx = x - (x1 - radius - 1);
      if (y < y0 + radius) dy = y0 + radius - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 1) {
        const t = (y - y0 - 2) / (size * 0.3);
        const a = Math.round((1 - t) * 24);
        setPx(px, size, x, y, 255, 255, 255, a);
      }
    }
  }

  // 3. KITT scanner bar in the center — glowing red
  const cy = Math.round(size / 2);
  const barH = Math.max(4, Math.round(size * 0.07));
  const barX0 = Math.round(size * 0.18);
  const barX1 = size - barX0;
  const barRadius = Math.round(barH / 2);

  // Outer glow (multiple passes for soft halo)
  for (let pass = 0; pass < 4; pass++) {
    const spread = (pass + 1) * Math.round(size * 0.025);
    const opacity = Math.round(40 / (pass + 1));
    for (let y = cy - barH / 2 - spread; y < cy + barH / 2 + spread; y++) {
      for (let x = barX0 - spread; x < barX1 + spread; x++) {
        const ix = Math.round(x), iy = Math.round(y);
        const distY = Math.abs(iy - cy) - barH / 2;
        const distX = Math.max(0, Math.max(barX0 - ix, ix - (barX1 - 1)));
        const dist = Math.sqrt(distX * distX + Math.max(0, distY) * Math.max(0, distY));
        if (dist < spread) {
          const a = Math.round(opacity * (1 - dist / spread));
          setPx(px, size, ix, iy, 255, 40, 40, a);
        }
      }
    }
  }

  // The scanner bar itself — bright red with white-hot center
  drawRoundedRect(px, size, barX0, cy - Math.floor(barH / 2), barX1, cy + Math.ceil(barH / 2), barRadius, [255, 30, 30, 255]);

  // Bright center hotspot — gradient from white to red
  const centerW = Math.round((barX1 - barX0) * 0.4);
  const centerX = Math.round((barX0 + barX1) / 2);
  for (let y = cy - Math.floor(barH / 2); y < cy + Math.ceil(barH / 2); y++) {
    for (let x = centerX - centerW / 2; x < centerX + centerW / 2; x++) {
      const ix = Math.round(x);
      const dx = (ix - centerX) / (centerW / 2);
      const intensity = Math.max(0, 1 - dx * dx);
      const r = 255;
      const g = Math.round(120 + intensity * 135);
      const b = Math.round(120 + intensity * 135);
      setPx(px, size, ix, y, r, g, b, Math.round(255 * intensity));
    }
  }
}

function drawTrayIcon(px, size) {
  const cy = Math.round(size / 2);
  const barH = Math.max(2, Math.round(size * 0.18));
  const barX0 = Math.round(size * 0.1);
  const barX1 = size - barX0;

  // Soft glow
  for (let pass = 0; pass < 2; pass++) {
    const spread = pass + 1;
    const opacity = Math.round(80 / (pass + 1));
    for (let y = cy - barH / 2 - spread; y < cy + barH / 2 + spread; y++) {
      for (let x = barX0 - spread; x < barX1 + spread; x++) {
        const ix = Math.round(x), iy = Math.round(y);
        const distY = Math.abs(iy - cy) - barH / 2;
        const distX = Math.max(0, Math.max(barX0 - ix, ix - (barX1 - 1)));
        const dist = Math.sqrt(distX * distX + Math.max(0, distY) * Math.max(0, distY));
        if (dist < spread) {
          const a = Math.round(opacity * (1 - dist / spread));
          setPx(px, size, ix, iy, 255, 40, 40, a);
        }
      }
    }
  }

  // Bar
  for (let y = cy - Math.floor(barH / 2); y < cy + Math.ceil(barH / 2); y++) {
    for (let x = barX0; x < barX1; x++) {
      setPx(px, size, x, y, 255, 30, 30, 255);
    }
  }
}

fs.writeFileSync('assets/icon.png', makePNG(512, drawAppIcon));
fs.writeFileSync('assets/tray-icon.png', makePNG(16, drawTrayIcon));
console.log('Icons generated:');
console.log('  assets/icon.png (512x512) – KITT-themed app icon');
console.log('  assets/tray-icon.png (16x16) – glowing red bar tray icon');
