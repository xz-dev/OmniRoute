import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-metadata-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "combo-metadata-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("single-target combo preserves its direct model metadata", async () => {
  await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-gpt-5.6-single-target-combo",
    accessToken: "codex-test-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  await combosDb.createCombo({
    name: "gpt-5.6-sol-combo",
    strategy: "auto",
    models: ["codex/gpt-5.6-sol"],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const direct = body.data.find((item) => item.id === "cx/gpt-5.6-sol");
  const combo = body.data.find((item) => item.id === "gpt-5.6-sol-combo");

  assert.equal(response.status, 200);
  assert.ok(direct);
  assert.ok(combo);
  for (const field of [
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
    "input_modalities",
    "output_modalities",
    "capabilities",
  ]) {
    assert.deepEqual(combo[field], direct[field], field);
  }
});

test("override-only custom target contributes persisted limits to public combo metadata", async () => {
  const target = "custom-dynamic/catalog-override-only";
  assert.equal(
    contextOverrides.setModelContextOverride("custom-dynamic", "catalog-override-only", 64000),
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
  await combosDb.createCombo({
    name: "catalog-override-only-combo",
    strategy: "auto",
    models: [target],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "catalog-override-only-combo");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.deepEqual(
    {
      context_length: combo.context_length,
      max_input_tokens: combo.max_input_tokens,
      max_output_tokens: combo.max_output_tokens,
    },
    { context_length: 64000, max_input_tokens: 50000, max_output_tokens: 7000 }
  );
});

test("override-only and known targets aggregate public limits conservatively", async () => {
  const target = "custom-dynamic/catalog-override-mixed";
  assert.equal(
    contextOverrides.setModelContextOverride("custom-dynamic", "catalog-override-mixed", 64000),
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
  await combosDb.createCombo({
    name: "catalog-override-mixed-combo",
    strategy: "auto",
    context_length_aggregation: "max",
    models: [target, "glm/glm-5.2"],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "catalog-override-mixed-combo");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.deepEqual(
    {
      context_length: combo.context_length,
      max_input_tokens: combo.max_input_tokens,
      max_output_tokens: combo.max_output_tokens,
    },
    { context_length: 1000000, max_input_tokens: 50000, max_output_tokens: 7000 }
  );
});

test("multi-target combo aggregates persisted target token-limit overrides", async () => {
  const targets = [
    {
      model: "gpt-5.6-sol",
      context: 372000,
      input: 300000,
      output: 90000,
    },
    {
      model: "gpt-5.6-terra",
      context: 272000,
      input: 250000,
      output: 80000,
    },
  ];

  for (const target of targets) {
    assert.equal(
      contextOverrides.setModelContextOverride("codex", target.model, target.context),
      true
    );
    assert.equal(
      capabilityOverrides.setModelCapabilityOverride(
        `codex/${target.model}`,
        "max_input_tokens",
        target.input
      ),
      true
    );
    assert.equal(
      capabilityOverrides.setModelCapabilityOverride(
        `codex/${target.model}`,
        "max_output_tokens",
        target.output
      ),
      true
    );
  }

  await combosDb.createCombo({
    name: "gpt-5.6-overridden-limits-combo",
    strategy: "auto",
    models: targets.map((target) => `codex/${target.model}`),
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "gpt-5.6-overridden-limits-combo");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.deepEqual(
    {
      context_length: combo.context_length,
      max_input_tokens: combo.max_input_tokens,
      max_output_tokens: combo.max_output_tokens,
    },
    {
      context_length: 272000,
      max_input_tokens: 250000,
      max_output_tokens: 80000,
    }
  );
});

test("maximum context aggregation preserves conservative input and output limits", async () => {
  await combosDb.createCombo({
    name: "gpt-5.6-maximum-context-combo",
    strategy: "auto",
    context_length_aggregation: "max",
    models: ["codex/gpt-5.6-sol", "codex/gpt-5.6-terra"],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "gpt-5.6-maximum-context-combo");

  assert.ok(combo);
  assert.equal(combo.context_length, 372000);
  assert.equal(combo.max_input_tokens, 250000);
  assert.equal(combo.max_output_tokens, 80000);
});

test("single-target combo respects registry reasoning overrides before specs", async () => {
  await providersDb.createProviderConnection({
    provider: "command-code",
    authType: "apikey",
    name: "command-code-gpt-5.4-mini-combo",
    apiKey: "command-code-test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  await combosDb.createCombo({
    name: "gpt-5.4-mini-command-code-combo",
    strategy: "auto",
    models: ["command-code/gpt-5.4-mini"],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "gpt-5.4-mini-command-code-combo");

  assert.equal(response.status, 200);
  assert.ok(combo);
  const capabilities = combo.capabilities as Record<string, unknown>;
  assert.equal(capabilities.reasoning, false);
  assert.equal(capabilities.thinking, false);
  assert.equal(capabilities.supportsThinking, false);
  assert.equal(Object.hasOwn(capabilities, "effort_tiers"), false);
});

test("single-target combo respects resolved reasoning deny patterns", async () => {
  await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "antigravity-gemini-no-thinking-combo",
    accessToken: "antigravity-test-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  await combosDb.createCombo({
    name: "antigravity-gemini-no-thinking-combo",
    strategy: "auto",
    models: ["antigravity/gemini-3.1-pro-high"],
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "antigravity-gemini-no-thinking-combo");

  assert.equal(response.status, 200);
  assert.ok(combo);
  const capabilities = combo.capabilities as Record<string, unknown>;
  assert.equal(capabilities.reasoning, false);
  assert.equal(capabilities.thinking, false);
  assert.equal(capabilities.supportsThinking, false);
  assert.equal(Object.hasOwn(capabilities, "effort_tiers"), false);
});
