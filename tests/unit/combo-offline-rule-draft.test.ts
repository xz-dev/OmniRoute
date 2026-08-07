import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OFFLINE_CONDITION,
  DEFAULT_OFFLINE_COOLDOWN_MS,
  clearOfflineRuleDraftError,
  clearOfflineRules,
  ensureOfflineRuleStepIds,
  formatOfflineCondition,
  hasActiveOfflineRuleDraftError,
  normalizeOfflineRuleModelEntry,
  parseOfflineRuleDraft,
  setOfflineRuleEnabled,
  validateHardOfflineParent,
  validateOfflineRuleStep,
} from "../../src/lib/combos/offlineRuleDraft.ts";

test("Dashboard offline-rule draft parses only bounded safe JSON Logic", () => {
  const parsed = parseOfflineRuleDraft(
    JSON.stringify({ "omniroute.accountUnavailable": [] }),
    "3600000"
  );
  assert.deepEqual(parsed, {
    success: true,
    condition: { "omniroute.accountUnavailable": [] },
    cooldownMs: 3_600_000,
  });

  assert.deepEqual(parseOfflineRuleDraft("not-json", "1000"), {
    success: false,
    error: "Condition must be valid JSON.",
  });
  const unknown = parseOfflineRuleDraft(JSON.stringify({ evil: [] }), "1000");
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /operator evil is not allowed/);
  assert.equal(parseOfflineRuleDraft("{}", "1.5").success, false);
});

test("Dashboard rule enable and disable uses a five-minute default", () => {
  const enabled = setOfflineRuleEnabled({ kind: "model", model: "codex/gpt" }, true);
  assert.equal(DEFAULT_OFFLINE_COOLDOWN_MS, 300_000);
  assert.deepEqual(enabled, {
    kind: "model",
    model: "codex/gpt",
    offlineCondition: DEFAULT_OFFLINE_CONDITION,
    offlineCooldownMs: 300_000,
  });
  assert.equal(validateOfflineRuleStep(enabled), null);
  assert.equal(
    formatOfflineCondition(enabled.offlineCondition).includes("accountUnavailable"),
    true
  );

  const disabled = setOfflineRuleEnabled(enabled, false);
  assert.deepEqual(disabled, { kind: "model", model: "codex/gpt" });
  assert.match(
    validateOfflineRuleStep({ offlineCondition: DEFAULT_OFFLINE_CONDITION }) || "",
    /configured together/
  );
});

test("leaving Guarded Priority removes guarded-only node fields", () => {
  assert.deepEqual(
    clearOfflineRules([
      {
        id: "primary",
        model: "codex/gpt",
        offlineCondition: DEFAULT_OFFLINE_CONDITION,
        offlineCooldownMs: 300_000,
      },
      { id: "paid", kind: "combo-ref", comboName: "paid-cache" },
    ]),
    [
      { id: "primary", model: "codex/gpt" },
      { id: "paid", kind: "combo-ref", comboName: "paid-cache" },
    ]
  );
});

test("Dashboard blocks incompatible Guarded Priority parent settings", () => {
  const steps = [
    {
      kind: "model",
      model: "codex/gpt",
      offlineCondition: DEFAULT_OFFLINE_CONDITION,
      offlineCooldownMs: 1000,
    },
    { kind: "combo-ref", comboName: "paid-cache" },
  ];
  assert.equal(
    validateHardOfflineParent(steps, "guarded-priority", { nestedComboMode: "execute" }),
    null
  );
  assert.match(
    validateHardOfflineParent(steps, "priority", { nestedComboMode: "execute" }) || "",
    /Guarded Priority/
  );
  assert.match(
    validateHardOfflineParent(steps, "guarded-priority", { nestedComboMode: "flatten" }) || "",
    /Execute/
  );
  assert.equal(validateHardOfflineParent([{ kind: "combo-ref" }], "weighted", {}), null);
});

test("all newly added model paths receive collision-free stable IDs", () => {
  const generated = ["offline-step-new-1", "offline-step-new-2", "offline-step-new-3"];
  const [existing, duplicate, first, second] = ensureOfflineRuleStepIds(
    [
      { id: "offline-step-new-1", model: "codex/existing" },
      { id: "offline-step-new-1", model: "codex/duplicate" },
      { model: "codex/first" },
      { kind: "combo-ref", comboName: "paid-cache" },
    ],
    () => generated.shift() || "offline-step-new-fallback"
  );
  assert.equal(existing.id, "offline-step-new-1");
  assert.equal(duplicate.id, "offline-step-new-2");
  assert.equal(first.id, "offline-step-new-3");
  assert.equal(second.id, "offline-step-new-fallback");
  assert.equal(new Set([existing.id, duplicate.id, first.id, second.id]).size, 4);
});

test("draft errors remain attached to stable steps through reorder and deletion", () => {
  const first = { id: "first", model: "codex/one" };
  const second = { id: "second", model: "codex/two" };
  const errors = { first: "invalid JSON" };
  assert.equal(hasActiveOfflineRuleDraftError([second, first], errors), true);
  const cleared = clearOfflineRuleDraftError(errors, "first");
  assert.deepEqual(cleared, {});
  assert.equal(hasActiveOfflineRuleDraftError([second], cleared), false);
});

test("structured model entries preserve rule and nested Combo fields during Dashboard normalization", () => {
  assert.deepEqual(normalizeOfflineRuleModelEntry("codex/gpt"), {
    id: "offline-step-0",
    model: "codex/gpt",
    weight: 0,
  });

  const comboRef = {
    id: "paid-fallback",
    kind: "combo-ref",
    comboName: "gpt-paid-cache",
    weight: 0,
    offlineCondition: DEFAULT_OFFLINE_CONDITION,
    offlineCooldownMs: 60_000,
  };
  assert.deepEqual(normalizeOfflineRuleModelEntry(comboRef), {
    ...comboRef,
    model: "gpt-paid-cache",
  });

  const wildcard = {
    id: "codex-pool",
    kind: "provider-wildcard",
    providerId: "codex",
    model: "gpt",
    weight: 0,
    offlineCondition: DEFAULT_OFFLINE_CONDITION,
    offlineCooldownMs: 3_600_000,
  };
  assert.deepEqual(normalizeOfflineRuleModelEntry(wildcard), {
    ...wildcard,
    model: "codex/*",
  });
});
