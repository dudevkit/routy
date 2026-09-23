// P0.3 — golden regression tests for the translation core.
// Level 1 (translator-level): input fixtures captured from upstream 9Router v0.5.75
// (commit of capture: 2026-09-17, via the capture script in the development tree).
// These fixtures pin upstream behavior; the port must reproduce them exactly
// (modulo normalized volatile fields).
//
// Normalized volatility (documented):
//   - Claude message_start ids are Date.now()-derived: "msg_<13-digit epoch>" → "msg_T"
//   - Everything else (tool ids, chatcmpl ids, usage, stop reasons) is input-derived
//     and must match byte-for-byte.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const R9 = path.join(HERE, "..", "..", "9router");

const { FORMATS } = await import(path.join(R9, "open-sse/translator/formats.js"));
const { translateRequest } = await import(path.join(R9, "open-sse/translator/index.js"));
const { createSSETransformStreamWithLogger } = await import(path.join(R9, "open-sse/utils/stream.js"));
const noopLogger = new Proxy({}, { get: () => () => {} });
const credentials = { _clientSessionId: "golden-session" };

//   - Claude message_start ids are Date.now()-derived: "msg_<13-digit epoch>" → "msg_T"
//   - Translated OpenAI chunk "created" is Date.now()/1000: numeric ≥1e9 → "T"
//   - Everything else (tool ids, chatcmpl ids, usage, stop reasons) is input-derived
//     and must match byte-for-byte.
function normalizeValue(v) {
  if (typeof v === "string") return v.replace(/msg_\d{13,}/g, "msg_T");
  if (typeof v === "number" && v >= 1e9 && Number.isInteger(v)) return "T"; // epoch seconds/ms
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, normalizeValue(val)]));
  }
  return v;
}
const normalizeText = (s) => s.replace(/msg_\d{13,}/g, "msg_T").replace(/"created":\d{10,}/g, '"created":T');

function deepDiff(a, b, at = "$") {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (JSON.stringify(na) === JSON.stringify(nb)) return null;
  if (na && nb && typeof na === "object" && typeof nb === "object" && !Array.isArray(na) === !Array.isArray(nb)) {
    const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
    for (const k of keys) {
      const d = deepDiff(na?.[k], nb?.[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${at}: expected ${JSON.stringify(nb)?.slice(0, 200)}\n  got      ${JSON.stringify(na)?.slice(0, 200)}`;
}

const reqFixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".input.json"))
  .map((f) => f.replace(".input.json", ""));

describe("golden request translation (openai<->claude)", () => {
  for (const name of reqFixtures) {
    it(`reproduces ${name}`, () => {
      const input = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.input.json`), "utf8"));
      const expected = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"));
      const translated = translateRequest(
        input.sourceFormat, input.targetFormat, input.model,
        structuredClone(input.body), true, credentials, null, noopLogger, [], null, null,
      );
      expect(translated).toBeTruthy();
      const rawMap = translated._toolNameMap instanceof Map ? Object.fromEntries(translated._toolNameMap) : (translated._toolNameMap || null);
      delete translated._toolNameMap;
      delete translated._customToolNames;
      const meta = { _toolNameMap: rawMap };
      expect(meta).toEqual(expected.meta);
      const diff = deepDiff(translated, expected.body);
      expect(diff, `divergence at ${diff ?? ""}`).toBeNull();
    });
  }
});

const streamFixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".input.sse.txt"))
  .map((f) => f.replace(".input.sse.txt", ""));

async function runUpstreamStream(upstreamFormat, clientFormat, rawSse) {
  const chunks = [];
  const ts = createSSETransformStreamWithLogger(
    upstreamFormat, clientFormat, null, noopLogger, null, "test-model", null,
    { messages: [{ role: "user", content: "hi" }] }, () => {}, null, null, credentials,
  );
  const readable = new ReadableStream({
    start(ctrl) { ctrl.enqueue(new TextEncoder().encode(rawSse)); ctrl.close(); },
  });
  await readable.pipeThrough(ts).pipeTo(new WritableStream({ write(c) { chunks.push(c); } }));
  return chunks.map((c) => (typeof c === "string" ? c : new TextDecoder().decode(c))).join("");
}

function parseFormatPair(name) {
  // e.g. "sse-openai-basic__to-claude-client" → upstream openai, client claude
  const m = name.match(/^sse-(openai|claude)-[a-z]+__to-(openai|claude)-client$/);
  if (!m) throw new Error(`cannot parse format pair from ${name}`);
  return { upstream: FORMATS[m[1].toUpperCase()], client: FORMATS[m[2].toUpperCase()] };
}

describe("golden response stream translation", () => {
  for (const name of streamFixtures) {
    it(`reproduces ${name}`, async () => {
      const { upstream, client } = parseFormatPair(name);
      const rawSse = readFileSync(path.join(FIXTURES, `${name}.input.sse.txt`), "utf8");
      const expected = readFileSync(path.join(FIXTURES, `${name}.expected.sse.txt`), "utf8");
      const actual = await runUpstreamStream(upstream, client, rawSse);
      expect(normalizeText(actual)).toBe(normalizeText(expected));
    });
  }
});
