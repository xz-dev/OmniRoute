import type { SqliteAdapter } from "../adapters/types";

const CANONICAL_VERSION = "143";
const CANONICAL_NAME = "api_keys_model_access_mode";

function hasModelAccessModeColumn(db: SqliteAdapter): boolean {
  const columns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name?: string }>;
  return columns.some((column) => column.name === "model_access_mode");
}

/** Apply the complete migration even when a prior variant already added the column. */
export function applyApiKeyModelAccessMigration(db: SqliteAdapter): void {
  if (!hasModelAccessModeColumn(db)) {
    db.exec(`
      ALTER TABLE api_keys
      ADD COLUMN model_access_mode TEXT NOT NULL DEFAULT 'all'
      CHECK (model_access_mode IN ('all', 'restricted'));
    `);
  }

  db.exec(`
    UPDATE api_keys
    SET model_access_mode = 'restricted'
    WHERE model_access_mode = 'all'
      AND NOT (
        allowed_models IS NULL OR trim(allowed_models) = ''
        OR (json_valid(allowed_models) = 1 AND (
          json_type(allowed_models) = 'null'
          OR (json_type(allowed_models) = 'array' AND json_array_length(allowed_models) = 0)
        ))
      );
  `);
}

/** Repair marker/schema drift without overwriting legitimate restricted-empty policies. */
export function reconcileAppliedApiKeyModelAccessMigration(db: SqliteAdapter): boolean {
  const marker = db
    .prepare("SELECT name FROM _omniroute_migrations WHERE version = ? AND name = ?")
    .get(CANONICAL_VERSION, CANONICAL_NAME) as { name?: string } | undefined;
  if (!marker) return false;

  if (!hasModelAccessModeColumn(db)) {
    db.transaction(() => applyApiKeyModelAccessMigration(db))();
    return true;
  }

  db.exec(`
    UPDATE api_keys
    SET model_access_mode = 'restricted'
    WHERE model_access_mode = 'all'
      AND NOT (
        allowed_models IS NULL OR trim(allowed_models) = ''
        OR (json_valid(allowed_models) = 1 AND (
          json_type(allowed_models) = 'null'
          OR (json_type(allowed_models) = 'array' AND json_array_length(allowed_models) = 0)
        ))
      );
  `);
  return false;
}
