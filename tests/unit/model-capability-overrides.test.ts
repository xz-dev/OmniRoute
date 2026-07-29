import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const moduleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-model-capability-overrides-"));
process.env.DATA_DIR = moduleDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const caps = await import("../../src/lib/modelCapabilities.ts");
const overrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const route = await import("../../src/app/api/model-capability-overrides/route.ts");

beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(moduleDataDir, { recursive: true, force: true });
  fs.mkdirSync(moduleDataDir, { recursive: true });
  coreDb.getDbInstance();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(moduleDataDir, { recursive: true, force: true });
});

function patchOverride(key: string, value: unknown) {
  return route.PATCH(
    new Request("http://localhost/api/model-capability-overrides", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "codex/gpt-5.6", key, value }),
    })
  );
}

describe("model capability overrides", () => {
  it("stores, lists, removes, and applies a provider/model max_token override", () => {
    const withoutOverride = caps.getResolvedModelCapabilities({
      provider: "openai",
      model: "gpt-4o",
    }).maxOutputTokens;
    const distinct = (withoutOverride ?? 0) + 12345;

    assert.equal(
      overrides.setModelCapabilityOverride("openai/gpt-4o", "max_token", distinct),
      true
    );
    assert.deepEqual(
      overrides.listModelCapabilityOverrides().map((entry) => ({
        target: entry.target,
        key: entry.key,
        value: entry.value,
      })),
      [{ target: "openai/gpt-4o", key: "max_token", value: distinct }]
    );
    assert.equal(
      caps.getResolvedModelCapabilities({ provider: "openai", model: "gpt-4o" }).maxOutputTokens,
      distinct
    );
    assert.notEqual(
      caps.getResolvedModelCapabilities({ provider: "anthropic", model: "gpt-4o" }).maxOutputTokens,
      distinct
    );
    assert.equal(overrides.removeModelCapabilityOverride("openai/gpt-4o", "max_token"), true);
    assert.equal(
      caps.getResolvedModelCapabilities({ provider: "openai", model: "gpt-4o" }).maxOutputTokens,
      withoutOverride
    );
  });

  it("uses exact input/output overrides, clamps input to context, and isolates effort variants", () => {
    const target = "codex/gpt-5.6";
    const variant = "codex/gpt-5.6-high";
    assert.equal(contextOverrides.setModelContextOverride("codex", "gpt-5.6", 372000), true);
    assert.equal(overrides.setModelCapabilityOverride(target, "max_input_tokens", 999999), true);
    assert.equal(overrides.setModelCapabilityOverride(target, "max_output_tokens", 128000), true);
    assert.equal(overrides.setModelCapabilityOverride(target, "max_token", 77777), true);

    const base = caps.getResolvedModelCapabilities(target);
    assert.deepEqual(
      {
        contextWindow: base.contextWindow,
        maxInputTokens: base.maxInputTokens,
        maxOutputTokens: base.maxOutputTokens,
      },
      { contextWindow: 372000, maxInputTokens: 372000, maxOutputTokens: 128000 }
    );
    assert.equal(overrides.removeModelCapabilityOverride(target, "max_output_tokens"), true);
    assert.equal(caps.getResolvedModelCapabilities(target).maxOutputTokens, 77777);

    const effort = caps.getResolvedModelCapabilities(variant);
    assert.notEqual(effort.contextWindow, 372000);
    assert.notEqual(effort.maxInputTokens, 372000);
    assert.notEqual(effort.maxOutputTokens, 77777);
  });

  it("applies overrides stored under provider-scoped model aliases", () => {
    assert.equal(
      overrides.setModelCapabilityOverride("github/claude-opus-4.5", "max_token", 77777),
      true
    );
    assert.equal(
      caps.getResolvedModelCapabilities({ provider: "github", model: "claude-opus-4.5" })
        .maxOutputTokens,
      77777
    );
  });

  it("accepts only supported positive integer keys through the API and deletes them", async () => {
    assert.equal((await patchOverride("max_input_tokens", 353400)).status, 200);
    assert.equal((await patchOverride("max_output_tokens", 128000)).status, 200);
    assert.equal((await patchOverride("max_token", 77777)).status, 200);
    assert.equal((await patchOverride("unknown", 1)).status, 400, "unsupported key");
    assert.equal((await patchOverride("max_input_tokens", 0)).status, 400, "non-positive integer");
    assert.equal(
      (await patchOverride("max_input_tokens", Number.POSITIVE_INFINITY)).status,
      400,
      "JSON serializes Infinity as null; route rejects the resulting non-number"
    );

    const removed = await route.DELETE(
      new Request(
        "http://localhost/api/model-capability-overrides?target=codex/gpt-5.6&key=max_output_tokens",
        { method: "DELETE" }
      )
    );
    assert.equal(removed.status, 200);
    assert.equal(
      caps.getResolvedModelCapabilities({ provider: "codex", model: "gpt-5.6" }).maxOutputTokens,
      77777,
      "deleting the specific output cap restores legacy max_token"
    );
  });

  it("rejects invalid targets and non-positive values", () => {
    assert.equal(overrides.setModelCapabilityOverride("gpt-4o", "max_token", 1000), false);
    assert.equal(overrides.setModelCapabilityOverride("openai/gpt-4o", "max_token", 0), false);
    assert.equal(overrides.setModelCapabilityOverride("openai/gpt-4o", "max_token", 1.5), false);
    assert.deepEqual(overrides.listModelCapabilityOverrides(), []);
  });
});
