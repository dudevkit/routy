// Read and edit a tool's config file by dotted path, preserving everything else.
//
// Three formats, one interface:
//   json / jsonc  parse → set → serialise
//   toml          targeted line edits, because a parse/serialise round trip would
//                 delete every comment in the file (9Router does exactly that, via
//                 the `confbox` dependency). routy has no dependencies, and text
//                 editing is both smaller and better behaved here.
//   yaml          targeted block edit, same reasoning
//
// Every setter returns the new file text. Nothing writes to disk here — the caller
// decides, so a failed patch cannot leave a half-written config.

/** JSON with a tolerance for the trailing commas hand-edited configs accumulate. */
export function parseJsonc(text) {
  const stripped = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

const split = (dotted) => String(dotted).split(".").filter(Boolean);

// ── JSON ────────────────────────────────────────────────────────────────────
function jsonGet(root, dotted) {
  let cur = root;
  for (const key of split(dotted)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}
function jsonSet(root, dotted, value) {
  const keys = split(dotted);
  let cur = root;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}
function jsonDelete(root, dotted) {
  const keys = split(dotted);
  let cur = root;
  for (const key of keys.slice(0, -1)) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[key];
  }
  if (cur && typeof cur === "object") delete cur[keys.at(-1)];
}

// ── TOML (line-oriented) ────────────────────────────────────────────────────
// `[ \t]` rather than `\s` throughout: `\s` matches newlines, so a greedy `\s*$`
// swallows the blank lines after a section header and the next key lands on the
// same line as the header.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOML_SECTION = (name) => new RegExp(`^[ \\t]*\\[${escapeRe(name)}\\][ \\t]*$`, "m");
const tomlKeyLine = (key) => new RegExp(`^([ \\t]*)${escapeRe(key)}[ \\t]*=`, "m");

/** `a.b.c` → { section: "a.b", key: "c" }; `a` → { section: null, key: "a" } */
const tomlParts = (dotted) => {
  const keys = split(dotted);
  return keys.length === 1 ? { section: null, key: keys[0] } : { section: keys.slice(0, -1).join("."), key: keys.at(-1) };
};

const tomlQuote = (value) =>
  typeof value === "boolean" || typeof value === "number" ? String(value) : `"${String(value).replace(/"/g, '\\"')}"`;

/** The slice of text belonging to `section`, or null. */
function tomlSectionRange(text, section) {
  if (!section) return { start: 0, end: text.length, headerAt: 0 };
  const m = text.match(TOML_SECTION(section));
  if (!m) return null;
  const newline = text.indexOf("\n", m.index);
  const start = newline === -1 ? text.length : newline + 1;
  const rest = text.slice(start);
  const next = rest.search(/^[ \t]*\[/m);
  return { start, end: next === -1 ? text.length : start + next, headerAt: m.index };
}

function tomlGet(text, dotted) {
  const { section, key } = tomlParts(dotted);
  const range = tomlSectionRange(text, section);
  if (!range) return undefined;
  const m = text.slice(range.start, range.end).match(tomlKeyLine(key));
  if (!m) return undefined;
  const line = text.slice(range.start + m.index).split(/\r?\n/)[0];
  const raw = line.slice(line.indexOf("=") + 1).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isFinite(n) && raw !== "" ? n : raw;
}

function tomlSet(text, dotted, value) {
  const { section, key } = tomlParts(dotted);
  const range = tomlSectionRange(text, section);
  const line = `${key} = ${tomlQuote(value)}`;

  if (!range) {
    // Append verbatim: normalising the file's trailing whitespace here is what
    // stops delete from restoring it, and a config we cannot put back exactly is
    // not one we should be editing.
    const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${base}[${section}]\n${line}\n`;
  }
  const body = text.slice(range.start, range.end);
  const m = body.match(tomlKeyLine(key));
  if (m) {
    const at = range.start + m.index;
    const endOfLine = text.indexOf("\n", at);
    const stop = endOfLine === -1 ? text.length : endOfLine;
    const indent = m[1] ?? "";
    return text.slice(0, at) + indent + line + text.slice(stop);
  }
  // key missing — put it directly under the section header
  const insertAt = text.lastIndexOf("\n", range.start) + 1 || range.start;
  return `${text.slice(0, insertAt)}${line}\n${text.slice(insertAt)}`;
}

function tomlDelete(text, dotted) {
  const { section, key } = tomlParts(dotted);
  const range = tomlSectionRange(text, section);
  if (!range) return text;
  const body = text.slice(range.start, range.end);
  const m = body.match(tomlKeyLine(key));
  if (!m) return text;
  const at = range.start + m.index;
  const endOfLine = text.indexOf("\n", at);
  const stop = endOfLine === -1 ? text.length : endOfLine + 1;
  let next = text.slice(0, at) + text.slice(stop);
  // Drop a section that no longer holds anything, removing exactly the header line
  // and its body — no surrounding trimming, so the bytes we appended are the bytes
  // we take away.
  if (section) {
    const after = tomlSectionRange(next, section);
    if (after && next.slice(after.start, after.end).trim() === "") {
      next = next.slice(0, after.headerAt) + next.slice(after.end);
    }
  }
  return next;
}

// ── YAML (block-oriented) ───────────────────────────────────────────────────
// Handles the shape these configs actually use: a top-level `parent:` block whose
// children are indented `key: value` lines. Not a general YAML implementation.
function yamlBlockRange(text, parent) {
  const head = new RegExp(`^${parent}:[ \\t]*\\r?\\n`, "m");
  const m = text.match(head);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const stop = rest.search(/^[^\s#]|^\s*\r?$/m);
  const body = stop === -1 ? rest : rest.slice(0, stop);
  return { start, end: start + body.length, headerAt: m.index };
}

const yamlLine = (key, value) => `  ${key}: "${String(value).replace(/"/g, '\\"')}"`;

function yamlGet(text, dotted) {
  const keys = split(dotted);
  if (keys.length === 1) {
    const m = text.match(new RegExp(`^${keys[0]}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : undefined;
  }
  const range = yamlBlockRange(text, keys[0]);
  if (!range) return undefined;
  const body = text.slice(range.start, range.end);
  const m = body.match(new RegExp(`^[ \\t]+${keys[1]}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
  return m ? m[1].trim() : undefined;
}

function yamlSet(text, dotted, value) {
  const keys = split(dotted);
  if (keys.length === 1) {
    const re = new RegExp(`^${keys[0]}:.*$`, "m");
    return re.test(text) ? text.replace(re, `${keys[0]}: "${value}"`) : `${text.replace(/\s*$/, "")}\n${keys[0]}: "${value}"\n`;
  }
  const [parent, child] = keys;
  const range = yamlBlockRange(text, parent);
  const line = yamlLine(child, value);
  if (!range) return `${text.replace(/\s*$/, "")}\n${parent}:\n${line}\n`;

  const body = text.slice(range.start, range.end);
  const existing = body.match(new RegExp(`^[ \\t]+${child}:.*$`, "m"));
  if (existing) {
    return text.slice(0, range.start) + body.replace(existing[0], line) + text.slice(range.end);
  }
  return `${text.slice(0, range.start)}${line}\n${text.slice(range.start)}`;
}

function yamlDelete(text, dotted) {
  const keys = split(dotted);
  if (keys.length === 1) {
    return text.replace(new RegExp(`^${keys[0]}:.*\\r?\\n?`, "m"), "");
  }
  const range = yamlBlockRange(text, keys[0]);
  if (!range) return text;
  const body = text.slice(range.start, range.end);
  const existing = body.match(new RegExp(`^[ \\t]+${keys[1]}:.*\\r?\\n?`, "m"));
  if (!existing) return text;
  let next = text.slice(0, range.start) + body.replace(existing[0], "") + text.slice(range.end);
  const after = yamlBlockRange(next, keys[0]);
  if (after && next.slice(after.start, after.end).trim() === "") {
    next = next.slice(0, after.headerAt) + next.slice(after.end);
  }
  return next;
}

// ── interface ───────────────────────────────────────────────────────────────
const FORMATS = {
  json: { parse: JSON.parse, dump: (root) => `${JSON.stringify(root, null, 2)}\n`, get: jsonGet, set: jsonSet, del: jsonDelete },
  jsonc: { parse: parseJsonc, dump: (root) => `${JSON.stringify(root, null, 2)}\n`, get: jsonGet, set: jsonSet, del: jsonDelete },
  toml: { text: true, get: tomlGet, set: tomlSet, del: tomlDelete },
  yaml: { text: true, get: yamlGet, set: yamlSet, del: yamlDelete },
};

export const supportedFormats = () => Object.keys(FORMATS);

/** Current value at `dotted`, or undefined. Never throws on a malformed file. */
export function getValue(text, format, dotted) {
  if (text == null) return undefined;
  const f = FORMATS[format];
  if (!f) throw new Error(`unsupported config format: ${format}`);
  try {
    if (f.text) return f.get(text, dotted);
    return f.get(f.parse(text), dotted);
  } catch {
    return undefined;
  }
}

/** Apply `{ dotted: value }` and return the new file text. */
export function setValues(text, format, changes) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unsupported config format: ${format}`);
  if (f.text) {
    let out = text ?? "";
    for (const [dotted, value] of Object.entries(changes)) out = f.set(out, dotted, value);
    return out;
  }
  let root;
  try {
    root = text ? f.parse(text) : {};
  } catch (err) {
    throw new Error(`config is not valid ${format}: ${err.message}`);
  }
  if (root == null || typeof root !== "object") root = {};
  for (const [dotted, value] of Object.entries(changes)) f.set(root, dotted, value);
  return f.dump(root);
}

/** Remove `dotted` paths and return the new file text. */
export function deleteValues(text, format, paths) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unsupported config format: ${format}`);
  if (f.text) {
    let out = text ?? "";
    for (const dotted of paths) out = f.del(out, dotted);
    return out;
  }
  let root;
  try {
    root = text ? f.parse(text) : {};
  } catch {
    return text; // unparseable: leave it alone rather than replacing it with {}
  }
  for (const dotted of paths) f.del(root, dotted);
  return f.dump(root);
}
