import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOfflineRuleFacts,
  matchesOfflineCondition,
  validateOfflineCondition,
} from "../../open-sse/services/combo/offlineRule.ts";
import { executeHardRuleRuntimeUnitCombo } from "../../open-sse/services/combo/runtimeUnits.ts";
import {
  clearNodeOfflineState,
  isNodeOffline,
  recordNodeOffline,
} from "../../open-sse/services/combo/offlineState.ts";
import {
  createComboSchema,
  validateEffectiveComboState,
} from "../../src/shared/validation/schemas/combo.ts";
import { mergeComboConfig } from "../../src/lib/combos/configMerge.ts";
import { normalizeRoutingStrategy } from "../../src/shared/constants/routingStrategies.ts";

const BUILTIN = { "omniroute.accountUnavailable": null };
const QUOTA_429 = () =>
  new Response(
    JSON.stringify({ error: { code: "insufficient_quota", message: "quota exhausted" } }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    }
  );
const PLAIN_429 = () =>
  new Response(JSON.stringify({ error: { message: "requests per minute exceeded" } }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
const OK = (body = "ok", headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    body: { model: "x" },
    combo: { name: "ordered", models: [] },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: {},
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 5,
      visitedComboNames: [] as string[],
      attemptBudget: { count: 0, limit: 20 },
    },
    baseOptions: { body: {}, combo: { name: "ordered", models: [] } } as never,
    runCombo: async () => new Response("nested"),
    ...overrides,
  };
}

function modelUnit(
  stepId: string,
  extras: Record<string, unknown> = {}
): {
  kind: "model";
  stepId: string;
  executionKey: string;
  modelStr: string;
  provider: string;
  providerId: null;
  connectionId: string | null;
  weight: number;
  label: null;
  offlineCondition?: unknown;
  offlineCooldownMs?: number;
  allowedConnectionIds?: string[];
} {
  return {
    kind: "model",
    stepId,
    executionKey: stepId,
    modelStr: `${stepId}/model`,
    provider: stepId,
    providerId: null,
    connectionId: null,
    weight: 0,
    label: null,
    ...extras,
  };
}

test("#9677 bounded response facts and explicit account-unavailable built-in", async () => {
  const facts = await buildOfflineRuleFacts(
    Response.json(
      { error: { code: "insufficient_quota", message: "quota exhausted" } },
      { status: 429, headers: { "X-Test": "ok" } }
    )
  );
  assert.equal(matchesOfflineCondition(BUILTIN, facts), true);
  const ordinary = await buildOfflineRuleFacts(
    Response.json({ error: { message: "requests per minute exceeded" } }, { status: 429 })
  );
  assert.equal(matchesOfflineCondition(BUILTIN, ordinary), false);
  const unavailable = await buildOfflineRuleFacts(new Response("down", { status: 503 }));
  assert.equal(matchesOfflineCondition(BUILTIN, unavailable), true);
  const otherServerError = await buildOfflineRuleFacts(new Response("down", { status: 502 }));
  assert.equal(matchesOfflineCondition(BUILTIN, otherServerError), false);
  assert.equal(
    matchesOfflineCondition({ "==": [{ var: "response.status" }, 429] }, ordinary),
    true
  );
  assert.ok(facts.response.text.length <= 4000);
  assert.equal(facts.response.headers["x-test"], "ok");
});

test("#9677 JSON Logic supports bounded array literals and rejects unsafe boundaries", () => {
  const facts = {
    response: { status: 200, statusText: "OK", text: "", headers: {} },
    error: { code: "", type: "", message: "" },
  };
  const rule = { in: ["quota", ["quota", "billing"]] };
  validateOfflineCondition(rule);
  assert.equal(matchesOfflineCondition(rule, facts), true);

  assert.throws(() => validateOfflineCondition(["x".repeat(4001)]), /too long/);
  let nested: unknown = "x";
  for (let i = 0; i < 20; i += 1) nested = [nested];
  assert.throws(() => validateOfflineCondition(nested), /depth/);
  assert.throws(
    () => validateOfflineCondition({ in: ["x", Array.from({ length: 70 }, () => "x")] }),
    /nodes/
  );
  assert.throws(() => validateOfflineCondition({ a: 1, b: 2 }), /operator/);
});

test("#9677 rule validation rejects unknown/prototype paths and resource abuse", () => {
  assert.throws(() => validateOfflineCondition({ eval: ["x"] }), /operator/);
  assert.throws(
    () => validateOfflineCondition({ "==": [{ var: "__proto__.polluted" }, true] }),
    /path/
  );
  assert.throws(
    () => validateOfflineCondition({ "==": [{ var: "constructor.prototype" }, true] }),
    /path/
  );
  let deep: unknown = true;
  for (let i = 0; i < 20; i += 1) deep = { "!": deep };
  assert.throws(() => validateOfflineCondition(deep), /depth/);
  const many: unknown = {
    and: Array.from({ length: 80 }, () => ({ "==": [1, 1] })),
  };
  assert.throws(() => validateOfflineCondition(many), /nodes|operator|depth/);
});

test("#9677 parent-child cooldown expires deterministically", () => {
  clearNodeOfflineState();
  recordNodeOffline("parent", "primary", 1000, 100);
  assert.equal(isNodeOffline("parent", "primary", 1099), true);
  assert.equal(isNodeOffline("parent", "primary", 1100), false);
});

test("#9677 ordered executor preserves nonmatch (200/plain429) and strips connection header", async () => {
  clearNodeOfflineState();
  for (const [label, responseFactory] of [
    ["200", () => OK("ok", { "X-OmniRoute-Selected-Connection-Id": "acct-1" })],
    [
      "plain429",
      () => {
        const r = PLAIN_429();
        const h = new Headers(r.headers);
        h.set("X-OmniRoute-Selected-Connection-Id", "acct-1");
        return new Response(r.body, { status: r.status, headers: h });
      },
    ],
  ] as const) {
    const calls: Array<Record<string, unknown>> = [];
    const primary = modelUnit("primary", {
      offlineCondition: BUILTIN,
      offlineCooldownMs: 1000,
    });
    const paid = modelUnit("paid", { connectionId: "paid-1" });
    const execution = await executeHardRuleRuntimeUnitCombo({
      ...baseArgs(),
      units: [primary, paid],
      handleSingleModel: async (_body, model, target) => {
        calls.push({ model, ...(target ?? {}) });
        return responseFactory();
      },
    } as never);
    assert.equal(calls.length, 1, label);
    assert.equal(String(calls[0].model).startsWith("primary/"), true, label);
    assert.equal(
      execution.response.headers.has("x-omniroute-selected-connection-id"),
      false,
      label
    );
    assert.equal(isNodeOffline("ordered", "primary"), false, label);
  }
});

test("#9677 pre-dispatch unavailability returns unchanged without paid fallback", async () => {
  clearNodeOfflineState();
  const calls: string[] = [];
  const execution = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [
      modelUnit("primary", { offlineCondition: BUILTIN, offlineCooldownMs: 1000 }),
      modelUnit("paid", { connectionId: "paid-1" }),
    ],
    isModelAvailable: async (_model, unit) => unit?.stepId !== "primary",
    handleSingleModel: async (_body, model) => {
      calls.push(String(model));
      return OK("paid-should-not-run");
    },
  } as never);
  assert.deepEqual(calls, []);
  assert.equal(execution.response.status, 503);
  assert.match(await execution.response.text(), /unavailable/);
  assert.equal(isNodeOffline("ordered", "primary"), false);
  assert.equal(
    execution.response.headers.has("x-omniroute-guarded-predispatch-unavailable"),
    false
  );
});

test("#9677 built-in 503 response cools primary and advances to paid", async () => {
  clearNodeOfflineState();
  const calls: string[] = [];
  const execution = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [
      modelUnit("primary", {
        offlineCondition: BUILTIN,
        offlineCooldownMs: 1000,
        connectionId: "fixed-primary",
      }),
      modelUnit("paid", { connectionId: "paid-1" }),
    ],
    handleSingleModel: async (_body, model) => {
      calls.push(String(model));
      return String(model).startsWith("primary/")
        ? new Response("service unavailable", { status: 503 })
        : OK("paid-after-503");
    },
  } as never);
  assert.deepEqual(calls, ["primary/model", "paid/model"]);
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "paid-after-503");
  assert.equal(isNodeOffline("ordered", "primary"), true);
});

test("#9677 matching explicit quota advances past primary to paid", async () => {
  clearNodeOfflineState();
  const calls: string[] = [];
  const execution = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [
      modelUnit("primary", { offlineCondition: BUILTIN, offlineCooldownMs: 1000 }),
      modelUnit("paid", { connectionId: "paid-1" }),
    ],
    handleSingleModel: async (_body, model) => {
      calls.push(String(model));
      if (String(model).startsWith("primary/")) return QUOTA_429();
      return OK("paid");
    },
  } as never);
  assert.deepEqual(calls, ["primary/model", "paid/model"]);
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "paid");
  assert.equal(isNodeOffline("ordered", "primary"), true);
});

test("#9677 dynamic account group excludes selected connection then tries peer before paid", async () => {
  clearNodeOfflineState();
  const seen: Array<{ model: string; exclude?: unknown; allowed?: unknown }> = [];
  let primaryAttempts = 0;
  const execution = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [
      modelUnit("primary", {
        offlineCondition: BUILTIN,
        offlineCooldownMs: 5000,
        // no connectionId → dynamic group path
      }),
      modelUnit("paid", { connectionId: "paid-1" }),
    ],
    handleSingleModel: async (_body, model, target) => {
      const t = (target ?? {}) as {
        excludeConnectionIds?: string[];
        allowedConnectionIds?: string[];
      };
      seen.push({
        model: String(model),
        exclude: t.excludeConnectionIds,
        allowed: t.allowedConnectionIds,
      });
      if (String(model).startsWith("primary/")) {
        primaryAttempts += 1;
        const selected = primaryAttempts === 1 ? "acct-a" : "acct-b";
        // second attempt still quota → after both, node cools and paid runs
        return new Response(
          JSON.stringify({ error: { code: "insufficient_quota", message: "quota exhausted" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "X-OmniRoute-Selected-Connection-Id": selected,
            },
          }
        );
      }
      return OK("paid-ok");
    },
  } as never);

  // Without allowedConnectionIds, loop continues until a selected id repeats (acct-b).
  assert.ok(primaryAttempts >= 2);
  assert.equal(seen[0].exclude, undefined);
  assert.deepEqual(seen[1].exclude, ["acct-a"]);
  assert.equal(seen[seen.length - 1].model, "paid/model");
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "paid-ok");
  assert.equal(execution.response.headers.has("x-omniroute-selected-connection-id"), false);
  assert.equal(isNodeOffline("ordered", "primary"), true);
});

test("#9677 all matching dynamic accounts then paid; exclude propagates into model target", async () => {
  clearNodeOfflineState();
  const excludes: Array<string[] | undefined> = [];
  let n = 0;
  await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [
      modelUnit("primary", {
        offlineCondition: BUILTIN,
        offlineCooldownMs: 1000,
        allowedConnectionIds: ["a", "b"],
      }),
      modelUnit("paid"),
    ],
    handleSingleModel: async (_body, model, target) => {
      const t = (target ?? {}) as { excludeConnectionIds?: string[] };
      excludes.push(t.excludeConnectionIds);
      if (String(model).startsWith("primary/")) {
        n += 1;
        return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
          status: 429,
          headers: { "X-OmniRoute-Selected-Connection-Id": n === 1 ? "a" : "b" },
        });
      }
      return OK("paid");
    },
  } as never);
  assert.equal(excludes[0], undefined);
  assert.deepEqual(excludes[1], ["a"]);
  assert.equal(excludes[2], undefined); // paid target has no exclusion
});

test("#9677 cooldown expiry restores first child on redispatch", async () => {
  clearNodeOfflineState();
  const primary = modelUnit("primary", {
    offlineCondition: BUILTIN,
    offlineCooldownMs: 1000,
    connectionId: "fixed-1",
  });
  const paid = modelUnit("paid", { connectionId: "paid-1" });
  const calls: string[] = [];
  const handle = async (_body: unknown, model: string) => {
    calls.push(String(model));
    if (String(model).startsWith("primary/")) return QUOTA_429();
    return OK("paid");
  };
  await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [primary, paid],
    handleSingleModel: handle,
  } as never);
  assert.deepEqual(calls, ["primary/model", "paid/model"]);
  assert.equal(isNodeOffline("ordered", "primary"), true);

  // still cooling → skip primary
  calls.length = 0;
  const cooled = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [primary, paid],
    handleSingleModel: handle,
  } as never);
  assert.deepEqual(calls, ["paid/model"]);
  assert.equal(await cooled.response.text(), "paid");

  // fake clock expiry via isNodeOffline read path + clear then re-record expired
  clearNodeOfflineState();
  recordNodeOffline("ordered", "primary", 1000, 0);
  assert.equal(isNodeOffline("ordered", "primary", 1000), false);

  calls.length = 0;
  await executeHardRuleRuntimeUnitCombo({
    ...baseArgs(),
    units: [primary, paid],
    handleSingleModel: async (_body, model) => {
      calls.push(String(model));
      return OK("restored");
    },
  } as never);
  assert.deepEqual(calls, ["primary/model"]);
});

test("#9677 nested execute matching advances; nested nonmatch returns unchanged", async () => {
  clearNodeOfflineState();
  const first = {
    kind: "combo-ref" as const,
    stepId: "child",
    executionKey: "child",
    comboName: "child-combo",
    weight: 0,
    label: null,
    offlineCondition: BUILTIN,
    offlineCooldownMs: 1000,
  };
  const second = modelUnit("paid", { connectionId: "paid-1" });

  let nestedCalls = 0;
  const match = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs({
      allCombos: [{ name: "child-combo", models: [] }],
      runCombo: async () => {
        nestedCalls += 1;
        return QUOTA_429();
      },
    }),
    units: [first, second],
    handleSingleModel: async () => OK("paid"),
  } as never);
  assert.equal(nestedCalls, 1);
  assert.equal(await match.response.text(), "paid");

  nestedCalls = 0;
  clearNodeOfflineState();
  const nonmatch = await executeHardRuleRuntimeUnitCombo({
    ...baseArgs({
      allCombos: [{ name: "child-combo", models: [] }],
      runCombo: async () => {
        nestedCalls += 1;
        return OK("child-ok");
      },
    }),
    units: [first, second],
    handleSingleModel: async () => OK("paid-should-not-run"),
  } as never);
  assert.equal(nestedCalls, 1);
  assert.equal(await nonmatch.response.text(), "child-ok");
});

test("#9677 ordinary Priority ignores stale hard-rule fields", async () => {
  const { hardOfflineRuleEnabled } = await import("../../open-sse/services/combo/offlineRule.ts");
  assert.equal(
    hardOfflineRuleEnabled({
      name: "legacy-priority",
      strategy: "priority",
      models: [
        {
          kind: "model",
          model: "primary/model",
          offlineCondition: BUILTIN,
          offlineCooldownMs: 1000,
        },
      ],
    } as never),
    false
  );
});

test("#9677 later pin cannot bypass hard offline rules (pin gate uses hardOfflineRuleEnabled)", async () => {
  const { hardOfflineRuleEnabled } = await import("../../open-sse/services/combo/offlineRule.ts");
  assert.equal(
    hardOfflineRuleEnabled({
      name: "x",
      strategy: "guarded-priority",
      models: [{ kind: "model", model: "a", offlineCondition: BUILTIN }],
    } as never),
    true
  );
  assert.equal(hardOfflineRuleEnabled({ name: "x", models: ["a/b"] } as never), false);
  // combo.ts: pinnedModel dispatch is skipped when hardOfflineRuleEnabled(combo)
  // so a later pin cannot short-circuit ordered hard-rule evaluation.
});

test("#9677 Guarded Priority is persisted distinctly and owns hard-rule fields", () => {
  const hardModels = [
    { kind: "model", model: "codex/gpt", offlineCondition: BUILTIN, offlineCooldownMs: 1000 },
  ];
  const plainModels = [{ kind: "model", model: "openai/gpt" }];

  assert.equal(normalizeRoutingStrategy("guarded-priority"), "guarded-priority");
  assert.equal(
    validateEffectiveComboState({
      models: hardModels,
      strategy: "guarded-priority",
      config: { nestedComboMode: "execute" },
    }).success,
    true
  );
  assert.equal(
    validateEffectiveComboState({
      models: hardModels,
      strategy: "priority",
      config: { nestedComboMode: "execute" },
    }).success,
    false,
    "ordinary priority must not silently acquire guarded semantics from stale fields"
  );
  assert.equal(
    validateEffectiveComboState({
      models: plainModels,
      strategy: "guarded-priority",
      config: { nestedComboMode: "execute" },
    }).success,
    false,
    "Guarded Priority must include at least one Hard Offline condition"
  );
  assert.equal(
    validateEffectiveComboState({ models: plainModels, strategy: "priority", config: {} }).success,
    true
  );
});

test("#9677 PUT route uses effective merged-state validation", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../src/app/api/combos/[id]/route.ts", import.meta.url), "utf8")
  );
  assert.match(source, /validateEffectiveComboState\(\{[\s\S]*models: nextComboState\.models/);
  assert.match(
    source,
    /normalizedUpdate\.config = mergeComboConfig\(currentConfig, normalizedUpdate\.config\)/
  );
});

test("#9677 incompatible config/runtime rejection; default combo unchanged", () => {
  const valid = createComboSchema.safeParse({
    name: "ordered-hard-rule",
    strategy: "guarded-priority",
    models: [
      { kind: "model", model: "codex/gpt", offlineCondition: BUILTIN, offlineCooldownMs: 60_000 },
    ],
    config: { nestedComboMode: "execute", hedging: false, shadowRouting: { enabled: false } },
  });
  assert.equal(valid.success, true);

  const incomplete = createComboSchema.safeParse({
    name: "bad",
    models: [{ kind: "model", model: "codex/gpt", offlineCondition: BUILTIN }],
  });
  assert.equal(incomplete.success, false);

  const wrongStrategy = createComboSchema.safeParse({
    name: "bad-strategy",
    strategy: "priority",
    models: [
      { kind: "model", model: "codex/gpt", offlineCondition: BUILTIN, offlineCooldownMs: 1000 },
    ],
    config: { nestedComboMode: "execute" },
  });
  assert.equal(wrongStrategy.success, false);

  const wrongMode = createComboSchema.safeParse({
    name: "bad-mode",
    strategy: "guarded-priority",
    models: [
      { kind: "model", model: "codex/gpt", offlineCondition: BUILTIN, offlineCooldownMs: 1000 },
    ],
    config: { nestedComboMode: "flatten" },
  });
  assert.equal(wrongMode.success, false);

  const defaultCombo = createComboSchema.safeParse({
    name: "plain",
    models: ["openai/gpt-4o"],
  });
  assert.equal(defaultCombo.success, true);
  if (defaultCombo.success) {
    assert.equal(defaultCombo.data.strategy, "priority");
    const first = defaultCombo.data.models[0];
    assert.equal(typeof first === "string" || !("offlineCondition" in (first as object)), true);
  }
});

test("#9677 config merge preserves dangerous own dynamic keys without prototype pollution", () => {
  const currentTiers = JSON.parse(
    '{"safe":{"stepId":"current"},"__proto__":{"stepId":"current-proto"},"constructor":{"stepId":"current-constructor"},"prototype":{"stepId":"current-prototype"}}'
  );
  const updateTiers = JSON.parse(
    '{"__proto__":{"label":"updated-proto"},"constructor":{"label":"updated-constructor"},"prototype":{"label":"updated-prototype"}}'
  );
  const merged = mergeComboConfig(
    { compositeTiers: { tiers: currentTiers } },
    { compositeTiers: { tiers: updateTiers } }
  );
  const tiers = (merged.compositeTiers as Record<string, unknown>).tiers as Record<
    string,
    Record<string, string>
  >;
  const constructorTier = tiers["constructor"];
  const prototypeTier = tiers["prototype"];

  assert.equal(Object.getPrototypeOf(merged), null);
  assert.equal(Object.getPrototypeOf(tiers), null);
  for (const tierName of ["__proto__", "constructor", "prototype"]) {
    assert.equal(Object.hasOwn(tiers, tierName), true);
  }
  assert.equal(Object.getPrototypeOf(tiers.__proto__), null);
  assert.equal(tiers.__proto__.stepId, "current-proto");
  assert.equal(tiers.__proto__.label, "updated-proto");
  assert.equal(constructorTier.stepId, "current-constructor");
  assert.equal(constructorTier.label, "updated-constructor");
  assert.equal(prototypeTier.stepId, "current-prototype");
  assert.equal(prototypeTier.label, "updated-prototype");
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("#9677 chat credential selection merges runtime excludeConnectionIds", async () => {
  // Focused seam: chat credential selection merges runtime excludeConnectionIds via
  // mergeExcludedConnectionIds. Full DB account selection is out of scope.
  const { mergeExcludedConnectionIds } =
    await import("../../src/sse/handlers/chat/comboTargetRuntime.ts");

  assert.deepEqual(
    mergeExcludedConnectionIds(new Set(["existing-a", "existing-b"]), ["runtime-c", "existing-a"]),
    ["existing-a", "existing-b", "runtime-c"]
  );
  assert.deepEqual(mergeExcludedConnectionIds(new Set(["only-existing"]), undefined), [
    "only-existing",
  ]);
  assert.deepEqual(mergeExcludedConnectionIds(new Set(["only-existing"]), null), ["only-existing"]);
  assert.deepEqual(mergeExcludedConnectionIds(new Set(), ["runtime-only"]), ["runtime-only"]);
  assert.deepEqual(mergeExcludedConnectionIds(new Set(), undefined), []);

  // Runtime unit spreads unit (including excludeConnectionIds) into handleSingleModel target.
  const runtime = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../open-sse/services/combo/runtimeUnits.ts", import.meta.url), "utf8")
  );
  assert.match(runtime, /excludeConnectionIds:\s*Array\.from\(attemptedConnections\)/);
  assert.match(
    runtime,
    /return args\.handleSingleModel\(args\.body, args\.unit\.modelStr, \{\s*\.\.\.args\.unit/s
  );
});
