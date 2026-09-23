// Derive the UI branding assets from the source artwork.
//
//   node scripts/make-logo-assets.mjs <wordmark.png> <favicon.png>
//
// Wordmark — a 2:1 canvas whose artwork sits inside ~190px of empty padding, drawn
// in near-white ink with a red dot. Built for a dark background, so it is invisible
// on the light theme. Cropped to the artwork and emitted as two twins that differ
// only in ink colour:
//
//   re-e-ui/src/assets/routy-wordmark-onDark.png   light ink → dark theme
//   re-e-ui/src/assets/routy-wordmark-onLight.png  dark ink  → light theme
//
// Favicon — an opaque square tile, emitted downscaled to a browser-sane size.
//
// Saturated pixels (the red dot) are preserved in every variant, so the mark keeps
// its identity. Alpha is untouched, which keeps antialiasing intact; colour work is
// done in premultiplied space to avoid dark halos at the edges.
//
// Re-run whenever the source artwork changes. Output is deterministic.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const wordmarkSrc = process.argv[2] ?? "logo.png";
const faviconSrc = process.argv[3] ?? "routy-favicon.png";
const ASSET_DIR = "re-e-ui/src/assets";
const PUBLIC_DIR = "re-e-ui/public";
const WORDMARK_WIDTH = 600;      // 2× a ~300px render — plenty, and small on disk
const FAVICON_SIZE = 512;
const LIGHT_INK = [18, 21, 26];  // graphite, matches the light theme's text
const ALPHA_FLOOR = 16;          // ignore fully-soft edge pixels when measuring
const SATURATION_MAX = 0.18;     // below this a pixel counts as neutral ink, not accent

// ── decode ──────────────────────────────────────────────────────────────────
function decodePng(buf) {
  if (buf.slice(1, 4).toString() !== "PNG") throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString("ascii");
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported: depth=${bitDepth} interlace=${interlace}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcRow = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = srcRow[x];
      dst[x] = filter === 0 ? v
        : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff
        : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
        : (v + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, colorType, channels, data: out };
}

// ── encode (RGBA, 8-bit, filter 0) ──────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── geometry ────────────────────────────────────────────────────────────────
const readerFor = (png) => (x, y) => {
  const i = y * png.width * png.channels + x * png.channels;
  return png.colorType === 6 ? [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]
    : png.colorType === 2 ? [png.data[i], png.data[i + 1], png.data[i + 2], 255]
    : [png.data[i], png.data[i], png.data[i], 255];
};

/** Tightest box containing every pixel at or above the alpha floor. */
function artworkBox(png, read) {
  let minX = png.width, minY = png.height, maxX = -1, maxY = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (read(x, y)[3] < ALPHA_FLOOR) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Box-downscale in premultiplied space (avoids dark halos on transparent edges). */
function resample(png, read, box, outWidth) {
  const outHeight = Math.max(1, Math.round((box.h / box.w) * outWidth));
  const out = Buffer.alloc(outWidth * outHeight * 4);
  for (let dy = 0; dy < outHeight; dy++) {
    const y0 = box.y + Math.floor((dy * box.h) / outHeight);
    const y1 = Math.max(y0 + 1, box.y + Math.floor(((dy + 1) * box.h) / outHeight));
    for (let dx = 0; dx < outWidth; dx++) {
      const x0 = box.x + Math.floor((dx * box.w) / outWidth);
      const x1 = Math.max(x0 + 1, box.x + Math.floor(((dx + 1) * box.w) / outWidth));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const [pr, pg, pb, pa] = read(x, y);
        const f = pa / 255;
        r += pr * f; g += pg * f; b += pb * f; a += pa; n++;
      }
      const alpha = a / n;
      const f = alpha / 255 || 1;
      const i = (dy * outWidth + dx) * 4;
      out[i] = Math.min(255, Math.round(r / n / f));
      out[i + 1] = Math.min(255, Math.round(g / n / f));
      out[i + 2] = Math.min(255, Math.round(b / n / f));
      out[i + 3] = Math.round(alpha);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

const saturationOf = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

// ── wordmark ────────────────────────────────────────────────────────────────
const wm = decodePng(fs.readFileSync(wordmarkSrc));
const wmRead = readerFor(wm);
const wmBox = artworkBox(wm, wmRead);
const wmOut = resample(wm, wmRead, wmBox, Math.min(WORDMARK_WIDTH, wmBox.w));

const lightInk = Buffer.from(wmOut.data);
let recoloured = 0, kept = 0;
for (let i = 0; i < lightInk.length; i += 4) {
  if (lightInk[i + 3] === 0) continue;
  if (saturationOf(lightInk[i], lightInk[i + 1], lightInk[i + 2]) <= SATURATION_MAX) {
    lightInk[i] = LIGHT_INK[0]; lightInk[i + 1] = LIGHT_INK[1]; lightInk[i + 2] = LIGHT_INK[2];
    recoloured++;
  } else kept++;
}

fs.mkdirSync(ASSET_DIR, { recursive: true });
const wmDark = path.join(ASSET_DIR, "routy-wordmark-onDark.png");
const wmLight = path.join(ASSET_DIR, "routy-wordmark-onLight.png");
fs.writeFileSync(wmDark, encodePng(wmOut.width, wmOut.height, wmOut.data));
fs.writeFileSync(wmLight, encodePng(wmOut.width, wmOut.height, lightInk));

console.log(`wordmark  ${wm.width}×${wm.height} → artwork ${wmBox.w}×${wmBox.h} → ${wmOut.width}×${wmOut.height} (${(wmOut.width / wmOut.height).toFixed(2)}:1)`);
console.log(`  ${wmDark}   ${(fs.statSync(wmDark).size / 1024).toFixed(1)}KB  light ink (dark theme)`);
console.log(`  ${wmLight}  ${(fs.statSync(wmLight).size / 1024).toFixed(1)}KB  dark ink (light theme)`);
console.log(`  ink: ${recoloured} neutral px darkened, ${kept} accent px preserved`);

// ── favicon ─────────────────────────────────────────────────────────────────
const fav = decodePng(fs.readFileSync(faviconSrc));
const favRead = readerFor(fav);
const favBox = artworkBox(fav, favRead);
const favOut = resample(fav, favRead, favBox, FAVICON_SIZE);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
const favPath = path.join(PUBLIC_DIR, "favicon.png");
fs.writeFileSync(favPath, encodePng(favOut.width, favOut.height, favOut.data));
console.log(`favicon   ${fav.width}×${fav.height} → ${favOut.width}×${favOut.height}  ${(fs.statSync(favPath).size / 1024).toFixed(1)}KB  ${favPath}`);
