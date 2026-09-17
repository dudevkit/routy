// RE-E logging — level-gated, redaction-aware, never blocks the loop on writes.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let currentLevel = LEVELS.info;

export function setLogLevel(name) {
  currentLevel = LEVELS[name] ?? LEVELS.info;
}

// Redact secrets in values destined for logs. Keys matched case-insensitively.
const REDACT_KEYS = /authorization|apikey|api_key|api-key|secret|token|password/i;
export function redact(obj, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < currentLevel) return;
  const line = {
    t: new Date().toISOString(),
    level,
    tag,
    msg: typeof msg === "string" ? msg : redact(msg),
    ...(extra ? { data: redact(extra) } : {}),
  };
  // sync console write is fine at our rates; file flushing lands with db layer
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

export const log = {
  debug: (tag, msg, extra) => emit("debug", tag, msg, extra),
  info: (tag, msg, extra) => emit("info", tag, msg, extra),
  raw: (tag, msg, extra) => {
    if (LEVELS.info < currentLevel) return;
    console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", tag, msg, ...(extra ? { data: extra } : {}) }));
  },
  warn: (tag, msg, extra) => emit("warn", tag, msg, extra),
  error: (tag, msg, extra) => emit("error", tag, msg, extra),
};
