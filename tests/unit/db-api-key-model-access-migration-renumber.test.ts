import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-access-migration-"));
const originalMigrationsDir = process.env.OMNIROUTE_MIGRATIONS_DIR;
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;

fs.writeFileSync(
  path.join(migrationsDir, "142_radar_referrals_cache.sql"),
  "CREATE TABLE radar_referrals_cache (id TEXT PRIMARY KEY);"
);
fs.writeFileSync(
  path.join(migrationsDir, "143_api_key_cache_default_mode.sql"),
  "ALTER TABLE api_keys ADD COLUMN cache_default_mode TEXT NOT NULL DEFAULT 'legacy';"
);
fs.writeFileSync(
  path.join(migrationsDir, "147_api_keys_model_access_mode.sql"),
  "ALTER TABLE api_keys ADD COLUMN model_access_mode TEXT NOT NULL DEFAULT 'all';"
);

const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");

test.after(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
  if (originalMigrationsDir === undefined) delete process.env.OMNIROUTE_MIGRATIONS_DIR;
  else process.env.OMNIROUTE_MIGRATIONS_DIR = originalMigrationsDir;
});

for (const legacyVersion of ["142", "143"]) {
  test(`API-key model access previously applied on ${legacyVersion} is rehomed to 147`, () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          allowed_models TEXT NOT NULL DEFAULT '[]',
          model_access_mode TEXT NOT NULL DEFAULT 'all'
        );
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO _omniroute_migrations (version, name)
        VALUES ('${legacyVersion}', 'api_keys_model_access_mode');
      `);

      assert.equal(runMigrations(db), 2);
      assert.deepEqual(
        db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
        [
          { version: "142", name: "radar_referrals_cache" },
          { version: "143", name: "api_key_cache_default_mode" },
          { version: "147", name: "api_keys_model_access_mode" },
        ]
      );
      const columns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
      assert.equal(columns.filter((column) => column.name === "model_access_mode").length, 1);
      assert.equal(columns.filter((column) => column.name === "cache_default_mode").length, 1);
      assert.equal(runMigrations(db), 0);
    } finally {
      db.close();
    }
  });
}
