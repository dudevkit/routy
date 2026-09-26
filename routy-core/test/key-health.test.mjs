// Key-health gate: the classifier's verdicts are the contract — what cools, what
// disables after two strikes, and above all what must NOT be punished because the
// provider is saturated for everyone. The rotation shape is also exercised end to end
// through the chat handler in chat-rotation.test.mjs; here the state machine is tested
// directly so every branch is pinned.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import {
  classifyConnectionError, recordConnectionFailure, recordConnectionSuccess,
  connectionState, isConnectionAvailable, earliestRecovery, connectionScope,
} from "../core/key-health.mjs";
import { CONNECTION_COOLDOWN_MS, CONNECTION_COOLDOWN_MAX_MS } from "../core/limits.mjs";

let tmp, db, repos, node;

function makeConnection(name = "k1") {
  return repos.connections.create({ nodeId: node.id, name, credentials: { apiKey: `sk-${name}` } });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "key-health-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
});

afterEach(() => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const err = (status, message = `HTTP ${status}`, extra = {}) => ({ status, message, errorCode: "x", ...extra });

describe("classifyConnectionError", () => {
  it("treats auth rejections and exhausted credit as key strikes", () => {
    expect(classifyConnectionError(err(401)).verdict).toBe("strike");
    expect(classifyConnectionError(err(403)).verdict).toBe("strike");
    expect(classifyConnectionError(err(402)).verdict).toBe("strike");
    expect(classifyConnectionError(err(403, "insufficient credits for this team")).verdict).toBe("strike");
  });

  it("classifies credit-body 400 responses as strikes (b.ai style), not node failures", () => {
    expect(classifyConnectionError(err(400, "credit insufficient balance: balance=13604 required=15206")).verdict).toBe("strike");
    expect(classifyConnectionError(err(400, "Insufficient Quota")).verdict).toBe("strike");
    // a generic 400 (invalid request) must stay a node problem, not a key strike
    expect(classifyConnectionError(err(400, "invalid parameter: model")).verdict).toBe("node");
  });

  it("counts 5xx and network errors as the node's problem, never the key's", () => {
    for (const e of [err(500), err(502), err(503), err(504), err(0, "fetch failed")]) {
      expect(classifyConnectionError(e).verdict).toBe("node");
    }
  });

  it("cools a key-scoped 429 by body text", () => {
    expect(classifyConnectionError(err(429, "your api key has exceeded its per-key rate limit")).verdict).toBe("cooldown");
  });

  it("flips to provider-wide once a second distinct key 429s in the window", () => {
    const connA = { id: "a" };
    const connB = { id: "b" };
    const set = new Set(["a"]); // a already 429'd this request
    const v = classifyConnectionError(err(429, "rate limited"), { connection: connB, recent429: set });
    expect(v.verdict).toBe("global");
    expect(v.others).toBe(1);
    // the same key again is still just its own problem
    const same = classifyConnectionError(err(429, "rate limited"), { connection: connA, recent429: set });
    expect(same.verdict).not.toBe("global");
  });
});

describe("recordConnectionFailure", () => {
  it("cools a 429 key for the default window and honours Retry-After", () => {
    const c = makeConnection();
    const now = Date.now();
    const v = recordConnectionFailure(repos, c, err(429, "key rate limited"), {}, now);
    expect(v.verdict).toBe("cooldown");
    expect(v.cooldownMs).toBe(CONNECTION_COOLDOWN_MS);
    expect(isConnectionAvailable(v.state, now)).toBe(false);
    expect(isConnectionAvailable(v.state, now + CONNECTION_COOLDOWN_MS + 1)).toBe(true);

    const c2 = makeConnection("k2");
    const v2 = recordConnectionFailure(repos, c2, err(429, "slow down", { retryAfterMs: 30_000 }), {}, now);
    expect(v2.cooldownMs).toBe(30_000);
  });

  it("doubles repeated cooldowns up to the cap", () => {
    const c = makeConnection();
    let now = Date.now();
    const first = recordConnectionFailure(repos, c, err(429, "limit"), {}, now);
    // simulate the cooldown expiring, then another 429
    repos.breakers.record(connectionScope(c.id), { state: "closed", openUntil: null });
    now += CONNECTION_COOLDOWN_MS + 1;
    const second = recordConnectionFailure(repos, c, err(429, "limit"), {}, now);
    expect(second.cooldownMs).toBe(CONNECTION_COOLDOWN_MS * 2);
    for (let i = 0; i < 8; i++) {
      repos.breakers.record(connectionScope(c.id), { state: "closed", openUntil: null });
      now += CONNECTION_COOLDOWN_MAX_MS;
      const v = recordConnectionFailure(repos, c, err(429, "limit"), {}, now);
      expect(v.cooldownMs).toBeLessThanOrEqual(CONNECTION_COOLDOWN_MAX_MS);
    }
  });

  it("disables on the second hard failure inside the window, and mirrors it into the row", () => {
    const c = makeConnection();
    const now = Date.now();
    const one = recordConnectionFailure(repos, c, err(401, "bad key"), {}, now);
    expect(one.verdict).toBe("strike");
    expect(one.strikes).toBe(1);
    expect(repos.connections.get(c.id).status).toBe("active");

    const two = recordConnectionFailure(repos, c, err(401, "bad key"), {}, now + 1000);
    expect(two.verdict).toBe("disable");
    expect(repos.connections.get(c.id).status).toBe("disabled");
    expect(isConnectionAvailable(connectionState(repos, c.id))).toBe(false);
  });

  it("lets a strike expire: failures outside the window do not accumulate", () => {
    const c = makeConnection();
    const now = Date.now();
    recordConnectionFailure(repos, c, err(401, "bad key"), {}, now);
    // an hour and a day later — the provider's billing blip has long passed
    const later = recordConnectionFailure(repos, c, err(401, "bad key"), {}, now + 61 * 60_000);
    expect(later.verdict).toBe("strike");
    expect(later.strikes).toBe(1);
    expect(repos.connections.get(c.id).status).toBe("active");
  });

  it("never touches the key on a node-scoped failure", () => {
    const c = makeConnection();
    const v = recordConnectionFailure(repos, c, err(502, "bad gateway"), {}, Date.now());
    expect(v.verdict).toBe("node");
    expect(connectionState(repos, c.id).state).toBe("closed");
    expect(repos.connections.get(c.id).status).toBe("active");
  });

  it("clears everything on success", () => {
    const c = makeConnection();
    const now = Date.now();
    recordConnectionFailure(repos, c, err(429, "limit"), {}, now);
    recordConnectionSuccess(repos, c.id);
    const s = connectionState(repos, c.id);
    expect(s.state).toBe("closed");
    expect(s.failures).toBe(0);
    expect(isConnectionAvailable(s)).toBe(true);
  });
});

describe("earliestRecovery", () => {
  it("reports the soonest cooldown expiry across keys and ignores healthy ones", () => {
    const a = makeConnection("a");
    const b = makeConnection("b");
    const now = Date.now();
    recordConnectionFailure(repos, a, err(429, "limit"), {}, now);
    recordConnectionFailure(repos, b, err(429, "slow down", { retryAfterMs: 10_000 }), {}, now);
    expect(earliestRecovery(repos, [a, b])).toBe(now + 10_000);
    expect(earliestRecovery(repos, [])).toBeNull();
  });
});
