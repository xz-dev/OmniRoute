import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-combo-context-runtime-"));

const { getComboTargetTokenLimit, resolveComboContextLimit } =
  await import("../../open-sse/services/contextManager.ts");

test("resolveComboContextLimit uses manual then configured aggregation when target is unknown", () => {
  const manual = resolveComboContextLimit({
    provider: "unknown_provider",
    model: "unknown_model",
    comboContextLength: 372000,
    comboContextAggregation: "max",
    comboTargetLimits: [272000, 1050000],
  });
  assert.deepEqual(manual, { limit: 372000, source: "combo-manual" });

  const maximum = resolveComboContextLimit({
    provider: "unknown_provider",
    model: "unknown_model",
    comboContextAggregation: "max",
    comboTargetLimits: [272000, 1050000],
  });
  assert.deepEqual(maximum, { limit: 1050000, source: "combo-max" });

  const minimum = resolveComboContextLimit({
    provider: "unknown_provider",
    model: "unknown_model",
    comboTargetLimits: [272000, 1050000],
  });
  assert.deepEqual(minimum, { limit: 272000, source: "combo-min" });
});

test("resolveComboContextLimit ignores unknown targets for minimum and maximum", () => {
  const known = getComboTargetTokenLimit({
    parsedProvider: "gemini",
    parsedModel: "gemini-2.5-pro",
  });
  const unknown = getComboTargetTokenLimit({
    parsedProvider: "unknown_provider",
    parsedModel: "unknown_model",
  });
  assert.equal(known.specific, true);
  assert.equal(unknown.specific, false);

  for (const [mode, source] of [
    ["min", "combo-min"],
    ["max", "combo-max"],
  ] as const) {
    assert.deepEqual(
      resolveComboContextLimit({
        provider: "unknown_provider",
        model: "unknown_model",
        comboContextAggregation: mode,
        comboTargetLimits: [known, unknown]
          .filter((target) => target.specific)
          .map((target) => target.limit),
      }),
      { limit: known.limit, source }
    );
  }
});

test("resolveComboContextLimit falls through when all targets are unknown", () => {
  const target = getComboTargetTokenLimit({
    parsedProvider: "unknown_provider",
    parsedModel: "unknown_model",
  });
  assert.equal(target.specific, false);
  assert.deepEqual(
    resolveComboContextLimit({
      provider: "unknown_provider",
      model: "unknown_model",
      comboContextAggregation: "max",
      comboTargetLimits: target.specific ? [target.limit] : [],
    }),
    { limit: 128000, source: "fallback" }
  );
});

test("resolveComboContextLimit keeps a concrete target limit authoritative", () => {
  const result = resolveComboContextLimit({
    provider: "gemini",
    model: "gemini-2.5-pro",
    comboContextLength: 372000,
    comboContextAggregation: "min",
    comboTargetLimits: [272000],
  });
  assert.deepEqual(result, { limit: 1048576, source: "target" });
});

test("resolveComboContextLimit handles array of combo target objects ({ name, models }) in comboTargetLimits", () => {
  const result = resolveComboContextLimit({
    provider: "unknown_provider",
    model: "unknown_model",
    comboTargetLimits: [
      { name: "subcombo1", models: [{ provider: "openai", model: "gpt-4" }] },
      { name: "subcombo2", models: [{ provider: "anthropic", model: "claude-3-5-sonnet" }] },
    ] as unknown as number[],
  });

  // Default fallback limit for unknown provider should be returned without throwing NaN or crash
  assert.equal(typeof result.limit, "number");
  assert.ok(!Number.isNaN(result.limit));
  assert.ok(result.limit > 0);
  assert.equal(result.source, "fallback");
});
