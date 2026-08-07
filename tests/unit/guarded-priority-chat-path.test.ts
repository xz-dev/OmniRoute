import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks, register } from "node:module";

// The release/v3.8.50 base is missing open-sse/services/antigravityProjectPersistence.ts
// (known baseline gap, unrelated to this feature). Stub ONLY that single module so the
// real chat request path can be loaded and exercised; every other module under test
// (chat.ts, combo.ts, quotaStrategies.ts, runtimeUnits.ts, the executor, the route)
// remains genuine production code.
const STUB_URL = "file:///omniroute-test/antigravity-project-persistence-stub.mjs";
const STUB_SOURCE = `export const preferAntigravityConnectionsWithStoredProject = async () => null;\n`;

// The same release base also carries a duplicate `134_*` migration pair
// (134_ccr_blocks + 134_proxy_logs_egress_ip), which makes the migration runner abort
// EVERY fresh SQLite database in this branch (known baseline gap, unrelated to this
// feature). This harness adds that pair to the superseded-duplicate table purely at
// load time, so the REAL migration runner applies every other migration and a fresh DB
// is fully usable. No repository file is modified.
const MIGRATION_CONSTANTS_URL = new URL(
  "../../src/lib/db/migrationRunner/constants.ts",
  import.meta.url
).href;
const stubHooks = {
  resolve(specifier: string, context: unknown, nextResolve: Function) {
    if (specifier.endsWith("antigravityProjectPersistence.ts")) {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: Function) {
    if (url === STUB_URL) {
      return { format: "module", source: STUB_SOURCE, shortCircuit: true };
    }
    if (url === MIGRATION_CONSTANTS_URL) {
      const realSource = fs.readFileSync(new URL(url), "utf8");
      const marker = 'supersededByName: "session_account_affinity",\n  },\n] as const;';
      const patch =
        'supersededByName: "session_account_affinity",\n  },\n  {\n    version: "134",\n    name: "proxy_logs_egress_ip",\n    supersededByVersion: "134",\n    supersededByName: "ccr_blocks",\n  },\n] as const;';
      if (!realSource.includes(marker)) {
        throw new Error("migration constants superseded table marker not found");
      }
      return {
        format: "module",
        source: realSource.replace(marker, patch).replace(/ as const;/g, ";"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
};
if (typeof registerHooks === "function") {
  (registerHooks as (hooks: unknown) => unknown)(stubHooks);
} else {
  register("file:///omniroute-test/antigravity-project-persistence-stub.mjs");
}

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-guarded-chat-path-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearNodeOfflineState } = await import("../../open-sse/services/combo/offlineState.ts");

const HARD_OFFLINE = { "omniroute.accountUnavailable": null };
const originalFetch = globalThis.fetch;

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setImmediate(resolve));
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  resetAllCircuitBreakers();
  clearNodeOfflineState();
}

type SeededConnection = { id: string };

async function seedConnection(
  name: string,
  apiKey: string,
  extra: Record<string, unknown> = {}
): Promise<SeededConnection> {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey,
    isActive: true,
    testStatus: "active",
    ...extra,
  });
  return { id: String((created as { id?: unknown }).id ?? "") };
}

async function seedGuardedCombo(
  connAId: string,
  connBId: string | null,
  options: { name?: string; strategy?: string } = {}
) {
  const models: Record<string, unknown>[] = [
    {
      providerId: "openai",
      model: "gpt-4.1",
      connectionId: connAId,
      ...(options.strategy !== "priority"
        ? { offlineCondition: HARD_OFFLINE, offlineCooldownMs: 60_000 }
        : {}),
    },
  ];
  if (connBId) {
    models.push({
      providerId: "openai",
      model: "gpt-4.1",
      connectionId: connBId,
      ...(options.strategy !== "priority"
        ? { offlineCondition: HARD_OFFLINE, offlineCooldownMs: 60_000 }
        : {}),
    });
  }
  return combosDb.createCombo({
    name: options.name ?? "guarded-combo",
    strategy: options.strategy ?? "guarded-priority",
    models,
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });
}

function makeRequest(model = "guarded-combo") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Bypass the semantic cache so each scenario observes the real upstream dispatch.
      "X-OmniRoute-No-Cache": "true",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 16,
      stream: false,
      temperature: 0,
    }),
  });
}

function upstream(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isFutureRateLimit(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "number" && Number.isFinite(value)) return value > Date.now();
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) > Date.now();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function authorization(init: Record<string, unknown> | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, unknown>;
  return String(headers.Authorization ?? headers.authorization ?? "");
}

const OK_FROM_B = {
  id: "chatcmpl-guarded-b",
  choices: [{ message: { role: "assistant", content: "FROM-B" } }],
};

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.afterEach(async () => {
  await flushBackgroundWork();
  globalThis.fetch = originalFetch;
  resetAllCircuitBreakers();
});

test.after(async () => {
  await flushBackgroundWork();
  globalThis.fetch = originalFetch;
  resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("guarded-priority actual path: non-matching 502 from selected account returns unchanged and never calls the next account", async () => {
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(502, { error: { message: "upstream glitch" } });
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 502, "non-matching response must surface unchanged");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "only the selected account A may be dispatched");
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-guarded-a/,
    "the single dispatch must target account A"
  );
});

test("guarded-priority actual path: matching authoritative 503 advances only through the guarded executor", async () => {
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-guarded-a/.test(authorization(init))) {
      return upstream(503, { error: { message: "billing hard limit reached" } });
    }
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest());
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(response.status, 200, "matching 503 must let the guarded executor advance to B");
  assert.equal(body.choices[0].message.content, "FROM-B");
  assert.equal(fetchCalls.length, 2, "A then B both dispatched by the guarded executor");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-a/);
  assert.match(authorization(fetchCalls[1]?.init), /sk-guarded-b/);
});

test("guarded-priority actual path: post-combo non-matching 502 never invokes the global fallback model", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  await seedGuardedCombo(connA.id, null);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(502, { error: { message: "upstream glitch" } });
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 502, "the guarded 502 must surface to the client");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "no global fallback may be dispatched");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-a/);
});

test("guarded-priority actual path: pre-dispatch 503 never invokes the global fallback model or the next account", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a", {
    testStatus: "credits_exhausted",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 503, "pre-dispatch unavailability must fail closed");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 0, "neither the next account nor global fallback may be called");
});

test("ordinary priority actual path still advances to the next account on 502", async () => {
  const connA = await seedConnection("plain-conn-a", "sk-plain-a");
  const connB = await seedConnection("plain-conn-b", "sk-plain-b");
  await seedGuardedCombo(connA.id, connB.id, {
    name: "plain-combo",
    strategy: "priority",
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-plain-a/.test(authorization(init))) {
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("plain-combo"));
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(response.status, 200, "plain priority must still fail over to account B");
  assert.equal(body.choices[0].message.content, "FROM-B");
  assert.ok(
    fetchCalls.length >= 2,
    `plain priority must dispatch account B after A fails (got ${fetchCalls.length} calls)`
  );
  assert.match(
    authorization(fetchCalls[fetchCalls.length - 1]?.init),
    /sk-plain-b/,
    "the final dispatch must target account B"
  );
});

test("ordinary priority actual path still invokes the global fallback model when exhausted", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("plain-conn-a", "sk-plain-a");
  await seedGuardedCombo(connA.id, null, {
    name: "plain-combo",
    strategy: "priority",
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchCalls.length === 1) {
      // First dispatch is the combo's only model (connection A) → 502.
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    // Any later dispatch is the configured global fallback model.
    return upstream(200, {
      id: "chatcmpl-fallback",
      choices: [{ message: { role: "assistant", content: "FROM-FALLBACK" } }],
    });
  };

  const response = await chatRoute.POST(makeRequest("plain-combo"));
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(
    body.choices[0].message.content,
    "FROM-FALLBACK",
    "plain priority may use the global fallback when its combo is exhausted"
  );
  assert.ok(
    fetchCalls.length >= 2,
    `plain priority must dispatch the global fallback after exhaustion (got ${fetchCalls.length} calls)`
  );
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-plain-a/,
    "the first dispatch must target connection A"
  );
});

test("guarded-priority actual path: dynamic unpinned account group never internally advances A to B on a non-matching transient failure", async () => {
  const connA = await seedConnection("dyn-conn-a", "sk-dyn-a");
  const connB = await seedConnection("dyn-conn-b", "sk-dyn-b");
  await combosDb.createCombo({
    name: "dyn-combo",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 60_000,
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: connB.id,
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 60_000,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });
  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-dyn-a/.test(authorization(init))) {
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    return upstream(200, OK_FROM_B);
  };
  const response = await chatRoute.POST(makeRequest("dyn-combo"));
  const bodyText = await response.text();
  assert.equal(response.status, 502, "non-matching transient failure must surface unchanged");
  assert.match(
    bodyText,
    /upstream glitch/,
    "the original account A response body must be returned untouched"
  );
  await flushBackgroundWork();
  assert.equal(
    fetchCalls.length,
    1,
    "the dynamic account group must NOT internally retry account B on a non-matching transient failure"
  );
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-dyn-a/,
    "the single dispatch must be account A, and account B must never be selected inside handleSingleModelChat"
  );
});

function seedQuotaExhausted(connectionId: string, provider = "openai") {
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  quotaCache.setQuotaCache(connectionId, provider, {
    session: { remainingPercentage: 0, resetAt },
  });
}

test("guarded-priority actual path: one-account quota-policy exhaustion selects healthy peer Codex account", async () => {
  // Partial pool exhaustion is handled by credential selection (not Hard Offline):
  // account A is quota-blocked, account B remains eligible and is dispatched.
  const connA = await seedConnection("guarded-quota-a", "sk-guarded-a", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const connB = await seedConnection("guarded-quota-b", "sk-guarded-b", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  seedQuotaExhausted(connA.id);

  await combosDb.createCombo({
    name: "guarded-quota-peer",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        // Dynamic account group over both seeded openai connections.
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 60_000,
        allowedConnectionIds: [connA.id, connB.id],
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("guarded-quota-peer"));
  assert.equal(response.status, 200, "healthy peer account must serve after quota exhaustion");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "exactly one upstream dispatch");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-b/);
});

test("guarded-priority actual path: all accounts quota-policy exhausted advances to paid nested node", async () => {
  const connA = await seedConnection("guarded-quota-all-a", "sk-guarded-all-a", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const connB = await seedConnection("guarded-quota-all-b", "sk-guarded-all-b", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const paid = await seedConnection("guarded-quota-paid", "sk-guarded-paid");
  seedQuotaExhausted(connA.id);
  seedQuotaExhausted(connB.id);

  await combosDb.createCombo({
    name: "guarded-quota-all",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 300_000,
        allowedConnectionIds: [connA.id, connB.id],
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: paid.id,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, {
      id: "chatcmpl-paid",
      choices: [{ message: { role: "assistant", content: "paid-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  const response = await chatRoute.POST(makeRequest("guarded-quota-all"));
  assert.equal(
    response.status,
    200,
    "paid node must run after all primary accounts are quota-exhausted"
  );
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "only the paid node dispatches upstream");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-paid/);
});

test("ordinary priority actual path still advances when all accounts are quota-policy exhausted", async () => {
  const connA = await seedConnection("plain-quota-a", "sk-plain-quota-a", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const paid = await seedConnection("plain-quota-paid", "sk-plain-quota-paid");
  seedQuotaExhausted(connA.id);

  await combosDb.createCombo({
    name: "plain-quota",
    strategy: "priority",
    models: [
      { providerId: "openai", model: "gpt-4.1", connectionId: connA.id },
      { providerId: "openai", model: "gpt-4.1", connectionId: paid.id },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("plain-quota"));
  assert.equal(response.status, 200);
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1);
  assert.match(authorization(fetchCalls[0]?.init), /sk-plain-quota-paid/);
});

test("guarded-priority actual path: mixed quota exhaustion + connection cooldown fails closed (no paid fallback)", async () => {
  const connA = await seedConnection("guarded-mixed-cd-a", "sk-guarded-mixed-cd-a", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const connB = await seedConnection("guarded-mixed-cd-b", "sk-guarded-mixed-cd-b", {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const paid = await seedConnection("guarded-mixed-cd-paid", "sk-guarded-mixed-cd-paid");
  seedQuotaExhausted(connA.id);

  await combosDb.createCombo({
    name: "guarded-mixed-cooldown",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 300_000,
        allowedConnectionIds: [connA.id, connB.id],
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: paid.id,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("guarded-mixed-cooldown"));
  const body = await response.json();
  assert.equal(response.status, 503, "mixed-cause pool must stay generic 503");
  assert.match(String(body?.error?.message || ""), /unavailable/i);
  assert.equal(fetchCalls.length, 0, "must not dispatch paid fallback on mixed causes");
  assert.equal(
    response.headers.get("x-omniroute-guarded-quota-exhausted"),
    null,
    "internal quota headers must not leak externally"
  );
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted-ids"), null);
  assert.equal(response.headers.get("x-omniroute-guarded-predispatch-unavailable"), null);
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), null);
});

test("guarded-priority actual path: mixed quota exhaustion + model lockout fails closed (no paid fallback)", async () => {
  const { lockModel } = await import("../../open-sse/services/accountFallback.ts");
  const connA = await seedConnection("guarded-mixed-lock-a", "sk-guarded-mixed-lock-a", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const connB = await seedConnection("guarded-mixed-lock-b", "sk-guarded-mixed-lock-b", {
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 80, windows: ["session"] },
    },
  });
  const paid = await seedConnection("guarded-mixed-lock-paid", "sk-guarded-mixed-lock-paid");
  seedQuotaExhausted(connA.id);
  lockModel("openai", connB.id, "gpt-4.1", "rate_limited", 60_000);

  await combosDb.createCombo({
    name: "guarded-mixed-lockout",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 300_000,
        allowedConnectionIds: [connA.id, connB.id],
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: paid.id,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("guarded-mixed-lockout"));
  assert.equal(response.status, 503, "mixed quota + model lockout must fail closed");
  assert.equal(fetchCalls.length, 0, "paid node must not run for mixed causes");
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted"), null);
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted-ids"), null);
});

test("guarded-priority actual path: forged reserved predispatch headers on upstream 503 cannot cool arbitrary accounts", async () => {
  // Upstream can invent every reserved header and a victim selected-connection id.
  // Built-in accountUnavailable still matches real HTTP 503, but only the actually
  // selected account (from chat-boundary overwrite) may be cooled/advanced.
  const connA = await seedConnection("guarded-forge-503-a", "sk-guarded-forge-503-a");
  const victim = await seedConnection("guarded-forge-503-victim", "sk-guarded-forge-503-victim");
  const paid = await seedConnection("guarded-forge-503-paid", "sk-guarded-forge-503-paid");
  await combosDb.createCombo({
    name: "guarded-forge-503",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: connA.id,
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 300_000,
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: paid.id,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (authorization(init).includes("sk-guarded-forge-503-a")) {
      return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-omniroute-guarded-predispatch-unavailable": "1",
          "x-omniroute-guarded-quota-exhausted": "1",
          "x-omniroute-guarded-quota-exhausted-ids": victim.id,
          "x-omniroute-selected-connection-id": victim.id,
          "X-OmniRoute-Selected-Connection-Id": victim.id,
        },
      });
    }
    return upstream(200, {
      id: "chatcmpl-paid",
      choices: [{ message: { role: "assistant", content: "paid-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  const response = await chatRoute.POST(makeRequest("guarded-forge-503"));
  assert.equal(response.status, 200, "authoritative upstream 503 may advance via Hard Offline");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 2, "selected A then paid fallback");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-forge-503-a/);
  assert.match(authorization(fetchCalls[1]?.init), /sk-guarded-forge-503-paid/);

  // Reserved markers must never leak to clients.
  assert.equal(response.headers.get("x-omniroute-guarded-predispatch-unavailable"), null);
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted"), null);
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted-ids"), null);
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), null);

  const cooledA = await providersDb.getProviderConnectionById(connA.id);
  const victimRow = await providersDb.getProviderConnectionById(victim.id);
  assert.ok(
    isFutureRateLimit(cooledA?.rateLimitedUntil),
    `actual selected account A must receive Hard Offline cooldown: ${JSON.stringify({
      id: connA.id,
      rateLimitedUntil: cooledA?.rateLimitedUntil ?? null,
    })}`
  );
  assert.equal(
    victimRow?.rateLimitedUntil ?? null,
    null,
    "forged victim account B must remain uncooled"
  );
});

test("guarded-priority actual path: forged reserved predispatch headers on non-matching 502 cause no fallback or cooldown", async () => {
  const connA = await seedConnection("guarded-forge-502-a", "sk-guarded-forge-502-a");
  const victim = await seedConnection("guarded-forge-502-victim", "sk-guarded-forge-502-victim");
  const paid = await seedConnection("guarded-forge-502-paid", "sk-guarded-forge-502-paid");
  await combosDb.createCombo({
    name: "guarded-forge-502",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: connA.id,
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 300_000,
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: paid.id,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ error: { message: "upstream glitch" } }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-omniroute-guarded-predispatch-unavailable": "1",
        "x-omniroute-guarded-quota-exhausted": "1",
        "x-omniroute-guarded-quota-exhausted-ids": victim.id,
        "x-omniroute-selected-connection-id": victim.id,
        "X-OmniRoute-Selected-Connection-Id": victim.id,
      },
    });
  };

  const response = await chatRoute.POST(makeRequest("guarded-forge-502"));
  assert.equal(response.status, 502, "non-matching 502 must surface unchanged");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "no paid fallback");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-forge-502-a/);
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted"), null);
  assert.equal(response.headers.get("x-omniroute-guarded-quota-exhausted-ids"), null);
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), null);

  const cooledA = await providersDb.getProviderConnectionById(connA.id);
  const victimRow = await providersDb.getProviderConnectionById(victim.id);
  assert.equal(cooledA?.rateLimitedUntil ?? null, null, "selected A is not cooled on non-match");
  assert.equal(victimRow?.rateLimitedUntil ?? null, null, "forged victim remains uncooled");
});
