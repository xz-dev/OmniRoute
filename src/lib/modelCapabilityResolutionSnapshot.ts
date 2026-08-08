/**
 * Build-local capability/context/override resolution snapshot (#9199).
 *
 * Catalog preparation bulk-loads the three capability tables once into a
 * build-local view for pure in-memory resolution. This must not flip models.dev's
 * module-global all-row cache, and ordinary runtime callers keep on-demand DB reads.
 *
 * Override maps are nested by provider then model so provider/model pairs cannot
 * collide via delimiter composition. Capability overrides keep separate maps for
 * `max_input_tokens` and `max_output_tokens` (loaded from one list query).
 */
import { listModelCapabilityOverrides } from "@/lib/db/modelCapabilityOverrides";
import { listModelContextOverrides } from "@/lib/db/modelContextOverrides";
import {
  loadAllSyncedCapabilitiesUncached,
  type CapabilitiesByProvider,
} from "@/lib/modelsDevSync";

/** Nested provider → model → numeric override map (collision-free). */
export type NestedOverrideMap = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface ModelCapabilityResolutionSnapshot {
  readonly synced: CapabilitiesByProvider;
  readonly maxInputTokenOverrides: NestedOverrideMap;
  readonly maxOutputTokenOverrides: NestedOverrideMap;
  readonly contextOverrides: NestedOverrideMap;
}

function setNestedOverride(
  map: Map<string, Map<string, number>>,
  provider: string,
  modelId: string,
  value: number
): void {
  let byModel = map.get(provider);
  if (!byModel) {
    byModel = new Map();
    map.set(provider, byModel);
  }
  byModel.set(modelId, value);
}

/**
 * Load all three capability tables in one uninterrupted JS turn.
 * Callers must not yield between the bulk reads if they need a coherent view;
 * existing catalog generation guards remain authoritative across later yields.
 *
 * Capability overrides are split into input/output maps after a single list read
 * so SQL cost stays one prepare/all per table, not one per override key.
 */
export function createModelCapabilityResolutionSnapshot(): ModelCapabilityResolutionSnapshot {
  const synced = loadAllSyncedCapabilitiesUncached();

  const maxInputTokenOverrides = new Map<string, Map<string, number>>();
  const maxOutputTokenOverrides = new Map<string, Map<string, number>>();
  for (const entry of listModelCapabilityOverrides()) {
    if (entry.key === "max_input_tokens") {
      setNestedOverride(maxInputTokenOverrides, entry.provider, entry.modelId, entry.value);
    } else if (entry.key === "max_output_tokens") {
      setNestedOverride(maxOutputTokenOverrides, entry.provider, entry.modelId, entry.value);
    }
  }

  const contextOverrides = new Map<string, Map<string, number>>();
  for (const entry of listModelContextOverrides()) {
    setNestedOverride(contextOverrides, entry.provider, entry.modelId, entry.realContext);
  }

  return {
    synced,
    maxInputTokenOverrides,
    maxOutputTokenOverrides,
    contextOverrides,
  };
}
