type JsonRecord = Record<string, unknown>;

const MERGEABLE_COMBO_CONFIG_KEYS = new Set([
  "responseValidation",
  "weights",
  "sla",
  "compositeTiers",
  "shadowRouting",
  "evalRouting",
  "fusionTuning",
  "contextRequirements",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setOwnDataProperty(record: JsonRecord, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function mergeOwnRecords(current: JsonRecord, update: JsonRecord): JsonRecord {
  const merged = Object.create(null) as JsonRecord;
  for (const [key, value] of Object.entries(current)) setOwnDataProperty(merged, key, value);
  for (const [key, value] of Object.entries(update)) setOwnDataProperty(merged, key, value);
  return merged;
}

function mergeCompositeTiers(current: JsonRecord, update: JsonRecord): JsonRecord {
  const merged = mergeOwnRecords(current, update);
  if (!isRecord(current.tiers) || !isRecord(update.tiers)) return merged;

  const tiers = mergeOwnRecords(current.tiers, update.tiers);
  for (const [tierName, updateTier] of Object.entries(update.tiers)) {
    const currentTier = current.tiers[tierName];
    setOwnDataProperty(
      tiers,
      tierName,
      isRecord(currentTier) && isRecord(updateTier)
        ? mergeOwnRecords(currentTier, updateTier)
        : updateTier
    );
  }
  setOwnDataProperty(merged, "tiers", tiers);
  return merged;
}

/**
 * Applies PATCH-like semantics to the record-valued portions of combo config.
 * Only schema-declared records are merged; arrays, scalars, nulls, and unknown
 * values replace the stored value.
 */
export function mergeComboConfig(current: JsonRecord, update: JsonRecord): JsonRecord {
  const merged = mergeOwnRecords(current, update);

  for (const key of MERGEABLE_COMBO_CONFIG_KEYS) {
    const currentValue = current[key];
    const updateValue = update[key];
    if (!isRecord(currentValue) || !isRecord(updateValue)) continue;

    merged[key] =
      key === "compositeTiers"
        ? mergeCompositeTiers(currentValue, updateValue)
        : mergeOwnRecords(currentValue, updateValue);
  }

  return merged;
}
