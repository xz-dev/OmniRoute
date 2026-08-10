import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const serial = { concurrency: false };

async function importFresh(modulePath: string) {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  return import(`${url}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function withMockedMigrationFs(files: Record<string, string>, fn: () => unknown) {
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;
  const isMigrationDir = (target: fs.PathLike) =>
    String(target).replaceAll("\\", "/").endsWith("/src/lib/db/migrations") ||
    String(target).replaceAll("\\", "/").endsWith("/migrations");

  fs.existsSync = (target) => (isMigrationDir(target) ? true : originalExistsSync(target));
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) =>
    isMigrationDir(target)
      ? Object.keys(files)
      : originalReaddirSync(target, options as never)) as typeof fs.readdirSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    const fileName = path.basename(String(target));
    return Object.hasOwn(files, fileName)
      ? files[fileName]
      : originalReadFileSync(target, options as never);
  }) as typeof fs.readFileSync;

  try {
    return fn();
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
  }
}

test(
  "runMigrations applies canonical 143 API-key model access on a fresh schema",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE api_keys (id TEXT PRIMARY KEY, allowed_models TEXT DEFAULT '[]');");
      const count = withMockedMigrationFs(
        {
          "143_api_keys_model_access_mode.sql": fs.readFileSync(
            path.resolve("src/lib/db/migrations/143_api_keys_model_access_mode.sql"),
            "utf8"
          ),
        },
        () => runner.runMigrations(db)
      );
      assert.equal(count, 1);
      const columns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
      assert.equal(
        columns.some((column) => column.name === "model_access_mode"),
        true
      );
      assert.deepEqual(db.prepare("SELECT version, name FROM _omniroute_migrations").all(), [
        { version: "143", name: "api_keys_model_access_mode" },
      ]);
    } finally {
      db.close();
    }
  }
);

test(
  "runMigrations repairs a pre-existing model access column before writing marker 143",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        allowed_models TEXT DEFAULT '[]',
        model_access_mode TEXT NOT NULL DEFAULT 'all'
      );
      INSERT INTO api_keys (id, allowed_models, model_access_mode) VALUES
        ('all', '[]', 'restricted'),
        ('restricted', '["openai/gpt-4.1"]', 'all');
    `);
      const files = {
        "143_api_keys_model_access_mode.sql": "this SQL must not execute directly",
      };
      const first = withMockedMigrationFs(files, () => runner.runMigrations(db));
      const second = withMockedMigrationFs(files, () => runner.runMigrations(db));

      assert.equal(first, 1);
      assert.equal(second, 0);
      assert.deepEqual(
        db.prepare("SELECT id, model_access_mode AS mode FROM api_keys ORDER BY id").all(),
        [
          { id: "all", mode: "restricted" },
          { id: "restricted", mode: "restricted" },
        ]
      );
      assert.deepEqual(db.prepare("SELECT version, name FROM _omniroute_migrations").all(), [
        { version: "143", name: "api_keys_model_access_mode" },
      ]);
    } finally {
      db.close();
    }
  }
);

test(
  "runMigrations reconciles canonical marker/schema drift and remains repeatable",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, allowed_models TEXT DEFAULT '[]');
      INSERT INTO api_keys (id, allowed_models) VALUES
        ('all', 'null'),
        ('restricted', '["openai/gpt-4.1"]');
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('143', 'api_keys_model_access_mode');
    `);
      const files = { "143_api_keys_model_access_mode.sql": "SELECT 1;" };
      const first = withMockedMigrationFs(files, () => runner.runMigrations(db));
      const second = withMockedMigrationFs(files, () => runner.runMigrations(db));

      assert.equal(first, 0, "schema repair must not invent another marker application");
      assert.equal(second, 0);
      assert.deepEqual(
        db.prepare("SELECT id, model_access_mode AS mode FROM api_keys ORDER BY id").all(),
        [
          { id: "all", mode: "all" },
          { id: "restricted", mode: "restricted" },
        ]
      );
    } finally {
      db.close();
    }
  }
);

test(
  "runMigrations completes a partial canonical 143 backfill without changing restricted-empty",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        allowed_models TEXT DEFAULT '[]',
        model_access_mode TEXT NOT NULL DEFAULT 'all'
      );
      INSERT INTO api_keys (id, allowed_models, model_access_mode) VALUES
        ('partial', '["openai/gpt-4.1"]', 'all'),
        ('deny-all', '[]', 'restricted');
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('143', 'api_keys_model_access_mode');
    `);
      const files = { "143_api_keys_model_access_mode.sql": "SELECT 1;" };
      assert.equal(
        withMockedMigrationFs(files, () => runner.runMigrations(db)),
        0
      );
      assert.equal(
        withMockedMigrationFs(files, () => runner.runMigrations(db)),
        0
      );
      assert.deepEqual(
        db.prepare("SELECT id, model_access_mode AS mode FROM api_keys ORDER BY id").all(),
        [
          { id: "deny-all", mode: "restricted" },
          { id: "partial", mode: "restricted" },
        ]
      );
    } finally {
      db.close();
    }
  }
);

test(
  "runMigrations repairs a legacy 135 marker and relocates it to canonical 143",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, allowed_models TEXT DEFAULT '[]');
      INSERT INTO api_keys (id, allowed_models) VALUES ('restricted', '["openai/gpt-4.1"]');
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('135', 'api_keys_model_access_mode');
    `);
      const files = {
        "135_migrate_model_capability_max_token.sql": "SELECT 1;",
        "143_api_keys_model_access_mode.sql": "SELECT 1;",
      };
      const count = withMockedMigrationFs(files, () => runner.runMigrations(db));

      assert.equal(count, 1, "the current 135 slot remains pending after legacy marker relocation");
      assert.equal(
        (db.prepare("SELECT model_access_mode AS mode FROM api_keys").get() as { mode: string })
          .mode,
        "restricted"
      );
      assert.deepEqual(
        db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
        [
          { version: "135", name: "migrate_model_capability_max_token" },
          { version: "143", name: "api_keys_model_access_mode" },
        ]
      );
    } finally {
      db.close();
    }
  }
);

test(
  "runMigrations reconciles the production 134/135 ledger before filling canonical slots",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");
    try {
      db.exec(`
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        allowed_models TEXT DEFAULT '[]',
        model_access_mode TEXT NOT NULL DEFAULT 'all'
          CHECK (model_access_mode IN ('all', 'restricted'))
      );
      CREATE TABLE proxy_logs (id TEXT PRIMARY KEY);
    `);
      const applied = db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)");
      for (const [version, name] of [
        ["134", "migrate_model_capability_max_token"],
        ["135", "api_keys_model_access_mode"],
        ["136", "radar_cache_settings"],
        ["137", "auto_restart_adopted"],
        ["138", "dario_fallback_backend"],
        ["139", "ccr_blocks"],
        ["140", "connection_runtime_state"],
        ["141", "modality_bridge_settings"],
      ])
        applied.run(version, name);

      const count = withMockedMigrationFs(
        {
          "134_proxy_logs_egress_ip.sql": "ALTER TABLE proxy_logs ADD COLUMN egress_ip TEXT;",
          "135_migrate_model_capability_max_token.sql": "SELECT 1;",
          "136_radar_cache_settings.sql": "SELECT 1;",
          "137_auto_restart_adopted.sql": "SELECT 1;",
          "138_dario_fallback_backend.sql": "SELECT 1;",
          "139_ccr_blocks.sql": "SELECT 1;",
          "140_connection_runtime_state.sql": "SELECT 1;",
          "141_modality_bridge_settings.sql": "SELECT 1;",
          "142_radar_referrals_cache.sql":
            "CREATE TABLE IF NOT EXISTS radar_referrals_cache (id INTEGER PRIMARY KEY CHECK (id = 1));",
          "143_api_keys_model_access_mode.sql":
            "ALTER TABLE api_keys ADD COLUMN model_access_mode TEXT;",
        },
        () => runner.runMigrations(db)
      );

      assert.equal(count, 2, "production ledger should apply freed 134 and upstream 142 slots");
      const rows = db
        .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version")
        .all() as Array<{
        version: string;
        name: string;
      }>;
      assert.deepEqual(
        rows.map((row) => `${row.version}:${row.name}`),
        [
          "134:proxy_logs_egress_ip",
          "135:migrate_model_capability_max_token",
          "136:radar_cache_settings",
          "137:auto_restart_adopted",
          "138:dario_fallback_backend",
          "139:ccr_blocks",
          "140:connection_runtime_state",
          "141:modality_bridge_settings",
          "142:radar_referrals_cache",
          "143:api_keys_model_access_mode",
        ]
      );
      const apiKeyColumns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
        name: string;
      }>;
      assert.equal(apiKeyColumns.filter((column) => column.name === "model_access_mode").length, 1);
      assert.equal(
        withMockedMigrationFs(
          {
            "134_proxy_logs_egress_ip.sql": "ALTER TABLE proxy_logs ADD COLUMN egress_ip TEXT;",
            "135_migrate_model_capability_max_token.sql": "SELECT 1;",
            "136_radar_cache_settings.sql": "SELECT 1;",
            "137_auto_restart_adopted.sql": "SELECT 1;",
            "138_dario_fallback_backend.sql": "SELECT 1;",
            "139_ccr_blocks.sql": "SELECT 1;",
            "140_connection_runtime_state.sql": "SELECT 1;",
            "141_modality_bridge_settings.sql": "SELECT 1;",
            "142_radar_referrals_cache.sql": "SELECT 1;",
            "143_api_keys_model_access_mode.sql": "SELECT 1;",
          },
          () => runner.runMigrations(db)
        ),
        0,
        "production ledger must remain stable on a second startup"
      );
      const proxyColumns = db.prepare("PRAGMA table_info(proxy_logs)").all() as Array<{
        name: string;
      }>;
      assert.equal(
        proxyColumns.some((column) => column.name === "egress_ip"),
        true
      );
    } finally {
      db.close();
    }
  }
);
