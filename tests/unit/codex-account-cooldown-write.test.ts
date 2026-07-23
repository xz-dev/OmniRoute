import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-cooldown-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-cooldown-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const codexAccount = await import("../../open-sse/services/codexAccount/index.ts");
const codexFailover = await import("../../open-sse/handlers/chatCore/codexFailover.ts");

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

interface SeededConnection {
  id: string;
  testStatus?: unknown;
  rateLimitedUntil?: unknown;
  lastError?: unknown;
  errorCode?: unknown;
  backoffLevel?: unknown;
  providerSpecificData: Record<string, unknown>;
}

interface PersistedConnection extends SeededConnection {
  providerSpecificData: {
    codexScopeRateLimitedUntil: Record<string, unknown>;
    unrelated?: unknown;
  };
}

async function seedCodexConnection(): Promise<SeededConnection> {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-cooldown-writer",
    email: "codex-cooldown@example.com",
    apiKey: null,
    accessToken: "codex-cooldown-access",
    refreshToken: "codex-cooldown-refresh",
    providerSpecificData: {
      unrelated: { retained: true },
    },
  }) as unknown as Promise<SeededConnection>;
}

async function readConnection(id: string): Promise<PersistedConnection> {
  const connection = await providersDb.getProviderConnectionById(id);
  assert.ok(connection);
  return connection as unknown as PersistedConnection;
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("persisting Codex and Spark child cooldowns retains sibling and unrelated state", async () => {
  const connection = await seedCodexConnection();
  const codexUntil = new Date(Date.now() + 60_000).toISOString();
  const sparkUntil = new Date(Date.now() + 120_000).toISOString();
  const parentBefore = await readConnection(connection.id);

  await codexAccount.persistCodexChildCooldown({
    connectionId: connection.id,
    model: "gpt-5.5",
    rateLimitedUntil: codexUntil,
  });
  const result = await codexAccount.persistCodexChildCooldown({
    connectionId: connection.id,
    model: "gpt-5.3-codex-spark",
    rateLimitedUntil: sparkUntil,
  });
  const persisted = await readConnection(connection.id);

  assert.deepEqual(result.providerSpecificData.codexScopeRateLimitedUntil, {
    codex: codexUntil,
    spark: sparkUntil,
  });
  assert.deepEqual(persisted.providerSpecificData.codexScopeRateLimitedUntil, {
    codex: codexUntil,
    spark: sparkUntil,
  });
  assert.deepEqual(persisted.providerSpecificData.unrelated, { retained: true });
  assert.equal(persisted.testStatus, parentBefore.testStatus);
  assert.equal(persisted.rateLimitedUntil, parentBefore.rateLimitedUntil);
  assert.equal(persisted.errorCode, parentBefore.errorCode);
  assert.equal(persisted.backoffLevel, parentBefore.backoffLevel);
});

test("chatCore failover mirrors persisted child state into the failed credential snapshot", async () => {
  const connection = await seedCodexConnection();
  const parentBefore = await readConnection(connection.id);
  const sparkUntil = new Date(Date.now() + 120_000).toISOString();
  const credentials = {
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
  };

  await codexFailover.markCodexScopeRateLimited({
    failedConnectionId: connection.id,
    model: "gpt-5.3-codex-spark",
    rateLimitedUntil: sparkUntil,
    credentials,
  });
  const persisted = await readConnection(connection.id);

  assert.equal(persisted.testStatus, parentBefore.testStatus);
  assert.equal(persisted.rateLimitedUntil, parentBefore.rateLimitedUntil);
  assert.equal(persisted.lastError, parentBefore.lastError);
  assert.equal(persisted.errorCode, parentBefore.errorCode);
  assert.equal(persisted.backoffLevel, parentBefore.backoffLevel);
  assert.equal(persisted.providerSpecificData.codexScopeRateLimitedUntil.spark, sparkUntil);
  assert.deepEqual(credentials.providerSpecificData, persisted.providerSpecificData);
});

test("concurrent Codex and Spark child cooldown writes retain both scopes", async () => {
  const connection = await seedCodexConnection();
  const codexUntil = new Date(Date.now() + 60_000).toISOString();
  const sparkUntil = new Date(Date.now() + 120_000).toISOString();

  await Promise.all([
    codexAccount.persistCodexChildCooldown({
      connectionId: connection.id,
      model: "gpt-5.5",
      rateLimitedUntil: codexUntil,
    }),
    codexAccount.persistCodexChildCooldown({
      connectionId: connection.id,
      model: "gpt-5.3-codex-spark",
      rateLimitedUntil: sparkUntil,
    }),
  ]);
  const persisted = await readConnection(connection.id);

  assert.deepEqual(persisted.providerSpecificData.codexScopeRateLimitedUntil, {
    codex: codexUntil,
    spark: sparkUntil,
  });
  assert.deepEqual(persisted.providerSpecificData.unrelated, { retained: true });
});
