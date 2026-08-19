// tests/unit/combo-context-prefix-resolution.test.ts
// Regression guard for computeComboContextLength()'s provider-prefix bug.
//
// resolveNestedComboTargets() returns target.modelStr in "provider/model" form
// (e.g. "glm/glm-5.2"), but computeComboContextLength() used to pass that
// qualified string straight into getCanonicalModelMetadata() without stripping
// the prefix first — unlike the catalog's own getComboTargetCatalogMetadata(),
// which strips it via getComboTargetModelId()/getProviderPrefixes() before the
// lookup. The alias-resolution chain (getResolvedModelCapabilities ->
// resolveCanonicalProviderModel -> resolveProviderModelAlias) does an exact-match
// lookup keyed by the BARE registry id, so a "provider/model" string only
// resolved for the handful of models with a curated MODEL_SPECS alias in that
// exact qualified form — every other registry-only model (the vast majority)
// silently fell out of the min() computation, and computed_context_length was
// dropped from the /api/combos response entirely.
//
// This test uses glm-5.2 (open-sse/config/providers/registry/glm — real
// 1,000,000-token context, no "glm/glm-5.2"-form curated alias) — the exact
// class of model the bug affected. Confirmed empirically before this fix
// landed: computeComboContextLength() returned `undefined` for a combo whose
// only member was "glm/glm-5.2", even though the bare "glm-5.2" resolves fine
// via getCanonicalModelMetadata() directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-combo-context-prefix-resolution-")
);
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const { buildComboContextDiagnostics, computeComboContextLength } =
  await import("../../src/lib/combos/comboContext.ts");
const { setModelContextOverride, removeModelContextOverride } =
  await import("../../src/lib/db/modelContextOverrides.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("computeComboContextLength resolves a registry-known, prefixed member (glm/glm-5.2) to its real context window", () => {
  const combo = {
    name: "prefix-resolution-probe-single",
    models: ["glm/glm-5.2"],
  };

  const result = computeComboContextLength(combo, []);

  assert.equal(
    result,
    1000000,
    "glm/glm-5.2 is a real registry model with a 1,000,000-token context window " +
      "(open-sse/config/providers/registry/glm) — the prefix must be stripped " +
      "before the canonical-model lookup so it is not silently excluded"
  );
});

test("computeComboContextLength defaults to minimum and supports maximum", () => {
  const base = {
    name: "prefix-resolution-probe-multi",
    models: ["glm/glm-5.2", "glm/glm-4.5"],
  };

  assert.equal(computeComboContextLength(base, []), 128000);
  assert.equal(
    computeComboContextLength({ ...base, context_length_aggregation: "max" }, []),
    1000000
  );
  assert.equal(
    computeComboContextLength(
      { ...base, context_length: 372000, context_length_aggregation: "max" },
      []
    ),
    372000
  );
});

test("combo context diagnostics report accurate per-field provenance", () => {
  const diagnostics = buildComboContextDiagnostics(
    {
      name: "source-probe",
      models: ["glm/glm-5.2"],
    },
    []
  );

  const target = diagnostics.targets[0];
  assert.equal(target.context_source, "authoritative-fallback");
  assert.equal(target.input_source, "authoritative-fallback");
  assert.equal(target.output_source, "registry");
  assert.equal(Object.hasOwn(target, "source"), false);
});

test("combo context diagnostics include override-only custom targets alone and mixed", () => {
  const target = "custom-dynamic/override-only-model";
  assert.equal(
    contextOverrides.setModelContextOverride("custom-dynamic", "override-only-model", 64000),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(target, "max_input_tokens", 50000),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(target, "max_output_tokens", 7000),
    true
  );

  const alone = buildComboContextDiagnostics({ name: "override-only", models: [target] }, []);
  assert.deepEqual(
    {
      effective: alone.effective_context_length,
      min: alone.known_min,
      max: alone.known_max,
      count: alone.known_count,
      target: alone.targets[0],
    },
    {
      effective: 64000,
      min: 64000,
      max: 64000,
      count: 1,
      target: {
        provider: "custom-dynamic",
        model: "override-only-model",
        context_length: 64000,
        max_input_tokens: 50000,
        max_output_tokens: 7000,
        context_source: "manual",
        input_source: "capability-override",
        output_source: "capability-override",
      },
    }
  );

  const mixed = {
    name: "override-only-mixed",
    models: [target, "glm/glm-5.2"],
  };
  const minimum = buildComboContextDiagnostics(mixed, []);
  const maximum = buildComboContextDiagnostics({ ...mixed, context_length_aggregation: "max" }, []);
  assert.deepEqual(
    {
      effective: minimum.effective_context_length,
      min: minimum.known_min,
      max: minimum.known_max,
      count: minimum.known_count,
    },
    { effective: 64000, min: 64000, max: 1000000, count: 2 }
  );
  assert.equal(maximum.effective_context_length, 1000000);
});

test("combo context diagnostics ignore unknown targets and report known bounds", () => {
  const diagnostics = buildComboContextDiagnostics(
    {
      name: "diagnostic-probe",
      context_length_aggregation: "max",
      models: ["glm/glm-5.2", "unknown-provider/unknown-model"],
    },
    []
  );

  assert.equal(diagnostics.effective_context_length, 1000000);
  assert.equal(diagnostics.known_min, 1000000);
  assert.equal(diagnostics.known_max, 1000000);
  assert.equal(diagnostics.known_count, 1);
  assert.equal(diagnostics.targets.length, 2);
  assert.ok(diagnostics.targets[1].unknown_reason);
});

test("computeComboContextLength honors a larger persisted Codex GPT-5.6 window", () => {
  const modelId = "gpt-5.6-terra";
  assert.equal(setModelContextOverride("codex", modelId, 500000, "manual"), true);
  try {
    assert.equal(
      computeComboContextLength({ models: [`codex/${modelId}`] }, []),
      500000,
      "the combo aggregate must use the effective override instead of the Codex registry default"
    );
  } finally {
    removeModelContextOverride("codex", modelId);
  }
});
