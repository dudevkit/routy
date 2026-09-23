// Minimal PNG reader — enough to answer the questions branding actually depends on:
// what colour is the ink, is it light or dark, and where does the artwork sit inside
// its own canvas. No dependencies; IDAT inflate + scanline unfilter only.
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
const buf = fs.readFileSync(file);

if (buf.slice(1, 4).toString() !== "PNG") throw new Error("not a PNG");

// ── chunks ──────────────────────────────────────────────────────────────────
let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.slice(pos + 4, pos + 8).toString("ascii");
  const data = buf.slice(pos + 8, pos + 8 + len);
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    interlace = data[12];
  } else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  pos += 12 + len;
}
if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported: depth=${bitDepth} interlace=${interlace}`);

const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
if (!channels) throw new Error(`unsupported colour type ${colorType}`);

// ── inflate + unfilter ──────────────────────────────────────────────────────
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;
const out = Buffer.alloc(height * stride);
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const src = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const dst = out.slice(y * stride, (y + 1) * stride);
  const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? dst[x - channels] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= channels ? prev[x - channels] : 0;
    const v = src[x];
    dst[x] = filter === 0 ? v
      : filter === 1 ? (v + a) & 0xff
      : filter === 2 ? (v + b) & 0xff
      : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
      : (v + paeth(a, b, c)) & 0xff;
  }
}

// ── measure ─────────────────────────────────────────────────────────────────
const px = (x, y) => {
  const i = y * stride + x * channels;
  return colorType === 6 ? [out[i], out[i + 1], out[i + 2], out[i + 3]]
    : colorType === 2 ? [out[i], out[i + 1], out[i + 2], 255]
    : [out[i], out[i], out[i], 255];
};
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

let n = 0, sr = 0, sg = 0, sb = 0, opaque = 0, minX = width, minY = height, maxX = -1, maxY = -1;
const histogram = new Map();
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const [r, g, b, a] = px(x, y);
    if (a < 16) continue;
    opaque++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (a < 200) continue; // ignore soft antialiased edges for colour averaging
    n++; sr += r; sg += g; sb += b;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
}
const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const avg = [sr / n, sg / n, sb / n];
const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => {
  const [r, g, b] = k.split(",").map((v) => (Number(v) << 4) + 8);
  return `${hex(r, g, b)} (${((c / n) * 100).toFixed(0)}%)`;
});

console.log(`file        ${file}`);
console.log(`size        ${width}×${height}  (aspect ${(width / height).toFixed(2)}:1)`);
console.log(`colour type ${colorType} (${colorType === 6 ? "RGBA" : colorType === 2 ? "RGB" : "grey"})`);
console.log(`coverage    ${((opaque / (width * height)) * 100).toFixed(1)}% of pixels are non-transparent`);
console.log(`ink bbox    x ${minX}..${maxX}  y ${minY}..${maxY}  (content ${maxX - minX + 1}×${maxY - minY + 1})`);
console.log(`ink colour  avg ${hex(...avg)}   luminance ${lum(...avg).toFixed(0)}/255 → ${lum(...avg) > 128 ? "LIGHT (visible on dark)" : "DARK (needs light background)"}`);
console.log(`top colours ${top.join(", ")}`);

// Column profile — tells a wordmark apart from a mark+wordmark lockup: a run of
// empty columns between two inked regions is the gap between them.
const cols = [];
for (let x = 0; x < width; x++) {
  let ink = 0;
  for (let y = 0; y < height; y++) if (px(x, y)[3] >= 16) ink++;
  cols.push(ink);
}
const runs = [];
let start = 0;
for (let x = 1; x <= width; x++) {
  const empty = x === width || cols[x] === 0;
  const wasEmpty = cols[start] === 0;
  if (x === width || (cols[x] === 0) !== wasEmpty) {
    runs.push({ from: start, to: x - 1, width: x - start, empty: cols[start] === 0 });
    start = x;
  }
}
const gaps = runs.filter((r) => r.empty && r.width >= 8 && r.from > 0 && r.to < width - 1);
console.log(`col runs    ${runs.length} regions; gaps >=8px: ${gaps.map((g) => `x ${g.from}..${g.to} (${g.width}px)`).join(", ") || "none"}`);
console.log(`layout      ${gaps.length === 0 ? "ONE contiguous block — no separate mark" : `${gaps.length} gap(s) → likely mark + wordmark`}`);

// Where the saturated (accent) pixels live — a red mark before the wordmark shows
// up as a tight cluster at one end; red inside the letters spreads across.
let aMinX = width, aMaxX = -1, aMinY = height, aMaxY = -1, aCount = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const [r, g, b, a] = px(x, y);
  if (a < 200) continue;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0 || (max - min) / max <= 0.18) continue;
  aCount++;
  if (x < aMinX) aMinX = x; if (x > aMaxX) aMaxX = x;
  if (y < aMinY) aMinY = y; if (y > aMaxY) aMaxY = y;
}
console.log(`accent px   ${aCount} at x ${aMinX}..${aMaxX} y ${aMinY}..${aMaxY} (${((aMaxX - aMinX + 1) / width * 100).toFixed(0)}% of the width)`);
