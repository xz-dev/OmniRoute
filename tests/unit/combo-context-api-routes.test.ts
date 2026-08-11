import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-context-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const nodesDb = await import("../../src/lib/db/providers/nodes.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const listRoute = await import("../../src/app/api/combos/route.ts");
const detailRoute = await import("../../src/app/api/combos/[id]/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  core.getDbInstance();
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("GET /api/combos resolves paginated nested refs against all combos without diagnostics", async () => {
  await combosDb.createCombo({
    name: "a-child",
    models: ["glm/glm-5.2"],
  });
  await combosDb.createCombo({
    name: "b-parent",
    models: [{ kind: "combo-ref", comboName: "a-child" }],
  });

  const response = await listRoute.GET(new Request("http://localhost/api/combos?limit=1&offset=1"));
  const body = (await response.json()) as {
    combos: Array<Record<string, unknown>>;
    total: number;
  };

  assert.equal(response.status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.combos.length, 1);
  assert.equal(body.combos[0].name, "b-parent");
  assert.equal(body.combos[0].computed_context_length, 1_000_000);
  assert.equal(Object.hasOwn(body.combos[0], "context_diagnostics"), false);
  assert.doesNotMatch(JSON.stringify(body), /openai-compatible-(?:chat|responses)-[0-9a-f-]+/i);
});

test("GET /api/combos/[id] exposes full diagnostics with configured public prefix", async () => {
  const nodeId = "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441";
  await nodesDb.createProviderNode({
    id: nodeId,
    type: "openai-compatible",
    prefix: "vibeproxy",
    name: "Vibe Proxy",
    apiType: "chat",
    baseUrl: "https://example.test/v1",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection(nodeId, nodeId, [
    { id: "custom-large", name: "custom-large", inputTokenLimit: 123_456 },
  ]);
  const combo = await combosDb.createCombo({
    name: "custom-prefix-combo",
    models: [`${nodeId}/custom-large`],
  });

  const response = await detailRoute.GET(new Request("http://localhost/api/combos/x"), {
    params: Promise.resolve({ id: combo.id }),
  });
  const body = (await response.json()) as {
    context_diagnostics: { targets: Array<{ provider: string; model: string }> };
  };

  assert.equal(response.status, 200);
  assert.equal(body.context_diagnostics.targets[0].provider, "vibeproxy");
  assert.equal(body.context_diagnostics.targets[0].model, "custom-large");
  assert.doesNotMatch(JSON.stringify(body.context_diagnostics), new RegExp(nodeId));
});
