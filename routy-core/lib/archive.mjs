// Minimal tar (ustar) reader and writer, plus gzip, on Node builtins only.
//
// The gateway has to unpack its own updates on a user's machine, and Node ships no
// tar implementation. Shelling out to `tar` would work here and fail on a host that
// lacks it — which is exactly the machine you cannot debug. So: ~150 lines, no
// dependency, same behaviour everywhere.
//
// Tar rather than zip because tar is a flat sequence of 512-byte blocks with no
// central directory to seek, which makes a correct *reader* much smaller.
import zlib from "node:zlib";

const BLOCK = 512;
const MAGIC = "ustar\0";
const VERSION = "00";

/** Octal field: zero-padded digits followed by NUL, per ustar. */
function octal(value, length) {
  const s = Math.max(0, value).toString(8).padStart(length - 1, "0");
  return Buffer.from(`${s}\0`, "ascii");
}

function checksum(header) {
  // The checksum is computed with its own field treated as spaces.
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of copy) sum += b;
  return Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii");
}

/** Split a path into ustar's name(100)/prefix(155) pair. */
function splitName(name) {
  if (name.length <= 100) return { name, prefix: "" };
  const cut = name.lastIndexOf("/", 100);
  if (cut < 0) throw new Error(`path too long for ustar: ${name}`);
  const prefix = name.slice(0, cut);
  if (prefix.length > 155) throw new Error(`path too long for ustar: ${name}`);
  return { name: name.slice(cut + 1), prefix };
}

function headerFor(name, size, { mode = 0o644, mtime = 0 } = {}) {
  const { name: short, prefix } = splitName(name);
  const h = Buffer.alloc(BLOCK);
  h.write(short, 0, 100, "utf8");
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.write("        ", 148, 8, "ascii"); // placeholder, replaced below
  h.write("0", 156, 1, "ascii"); // typeflag: regular file
  h.write(MAGIC, 257, 6, "ascii");
  h.write(VERSION, 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  checksum(h).copy(h, 148);
  return h;
}

/**
 * Pack `{ path, data }` entries into a tar buffer.
 *
 * mtime is fixed at 0 and uid/gid at 0 so the same input always produces the same
 * bytes — which is what makes the release checksum meaningful.
 */
export function packTar(entries) {
  const parts = [];
  for (const { path: name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    parts.push(headerFor(name, body.length));
    parts.push(body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

const readOctal = (buf, offset, length) => {
  const s = buf.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
};

/**
 * Unpack a tar buffer into `{ path, data }` entries. Directories are skipped —
 * the caller creates parents as needed.
 *
 * Rejects absolute paths and any `..` segment. This runs on content fetched from
 * the network, so a crafted archive must not be able to write outside the install
 * directory; that is the whole point of checking here rather than at the caller.
 */
export function unpackTar(buf) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end marker
    const rawName = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readOctal(header, 124, 12);
    const type = header.toString("ascii", 156, 157);
    offset += BLOCK;

    if (name) {
      assertSafePath(name);
      if (type === "0" || type === "\0" || type === "") {
        entries.push({ path: name, data: Buffer.from(buf.subarray(offset, offset + size)) });
      }
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Refuse anything that could escape the extraction root. */
export function assertSafePath(name) {
  const normalised = name.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised)) {
    throw new Error(`archive entry has an absolute path: ${name}`);
  }
  if (normalised.split("/").some((seg) => seg === "..")) {
    throw new Error(`archive entry escapes the extraction root: ${name}`);
  }
  return true;
}

export const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });
export const gunzip = (buf) => zlib.gunzipSync(buf);
