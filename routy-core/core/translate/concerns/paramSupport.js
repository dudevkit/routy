import { getCapabilitiesForModel } from "../deps/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  // MiMo Desktop Preview models (account-service route): content must be plain string,
  // rejects OpenAI content-part array. Cloud models keep their parts (mimo-v2-omni is multi-modal).
  { provider: "xiaomi-mimo", match: /preview/i, flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // Deliberately NO b.ai rule. `reasoning_effort` was reported to 400 on b.ai for every value
  // outside low/high/max, but on this gateway's b.ai node *every* value is accepted —
  // none/minimal/low/medium/high/max/absent all return 200, and `none` uses a third of the
  // tokens the others do, so the provider is honouring the field rather than ignoring it. A rule
  // here would silently discard a reasoning level the client asked for and the provider accepts.
  // If a specific model is found to reject some values, scope a rule to it:
  //   { provider: "bai", match: /<that model>/, paramValues: { reasoning_effort: { allow: [...], otherwise: null } } },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

/**
 * Apply `paramValues` specs to a body. Exported because the vocabulary is the part worth
 * testing on its own: a rule says which values a provider accepts, and what an unaccepted one
 * becomes — dropped (`otherwise: null`, the provider's own default) or replaced (a string).
 * Returns the changes it made, in the same shape `stripUnsupportedParams` reports.
 */
export function applyParamValues(body, paramValues) {
  const changes = [];
  for (const [key, spec] of Object.entries(paramValues || {})) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (spec.allow?.includes(value)) continue;
    if (spec.otherwise === null || spec.otherwise === undefined) {
      changes.push({ param: key, from: value, to: undefined });
      delete body[key];
    } else {
      changes.push({ param: key, from: value, to: spec.otherwise });
      body[key] = spec.otherwise;
    }
  }
  return changes;
}

/**
 * Remove unsupported params from body in place, and report what was changed.
 *
 * The report is the point: a policy that silently edits a caller's request is a policy nobody
 * can audit. This function was dead code for its whole life precisely because nothing observed
 * it, and the first rule I added to it turned out to be wrong for the provider it named —
 * dropping a value that provider accepts. A log line per change is what makes the next such
 * mistake visible instead of invisible.
 *
 * @returns {Array<{param: string, from: unknown, to: unknown}>} one entry per change, [] if none
 */
export function stripUnsupportedParams(provider, model, body) {
  const changes = [];
  if (!model || !body || typeof body !== "object") return changes;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) {
        changes.push({ param: key, from: body[key], to: undefined });
        delete body[key];
      }
    }
    // Values a provider accepts are a set, not "the field" — dropping the field outright would
    // also discard the values that work.
    for (const change of applyParamValues(body, rule.paramValues)) changes.push(change);
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      let flattened = 0;
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
          flattened++;
        }
      }
      if (flattened) changes.push({ param: "messages[].content", from: "content parts", to: "flattened string", count: flattened });
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
          const before = body[key];
          clampNumber(body, key, ceiling);
          if (before !== body[key]) changes.push({ param: key, from: before, to: body[key] });
        }
      }
    }
  }
  return changes;
}
