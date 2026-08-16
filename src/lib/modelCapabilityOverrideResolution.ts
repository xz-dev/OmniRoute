import { getModelCapabilityOverride } from "@/lib/db/modelCapabilityOverrides";
import {
  getModelContextOverrideRecord,
  type ModelContextOverride,
} from "@/lib/db/modelContextOverrides";
import type { ModelCapabilityResolutionSnapshot } from "@/lib/modelCapabilityResolutionSnapshot";

export interface ResolvedCapabilityIdentity {
  provider: string | null;
  model: string | null;
  rawModel: string | null;
}

/**
 * Exact-match capability override lookup with intentional raw-alias fallback.
 *
 * An override may be stored under either the canonical model id or the exact
 * provider-scoped raw alias supplied by the operator. There is deliberately no
 * suffix, effort, or family inheritance.
 */
export function getCapabilityOverride(
  resolved: ResolvedCapabilityIdentity,
  key: "max_input_tokens" | "max_output_tokens",
  bulkOverrides?: ReadonlyMap<string, ReadonlyMap<string, number>> | null
): number | null {
  const canonical = getModelCapabilityOverride(
    resolved.provider,
    resolved.model,
    key,
    bulkOverrides
  );
  if (canonical !== null) return canonical;
  return resolved.rawModel && resolved.rawModel !== resolved.model
    ? getModelCapabilityOverride(resolved.provider, resolved.rawModel, key, bulkOverrides)
    : null;
}

export function getContextOverrideRecord(
  resolved: ResolvedCapabilityIdentity,
  snapshot?: ModelCapabilityResolutionSnapshot | null
): ModelContextOverride | null {
  const lookup = (model: string | null) => {
    if (!resolved.provider || !model) return null;
    if (!snapshot) return getModelContextOverrideRecord(resolved.provider, model);

    const record = snapshot.contextOverrideRecords?.get(resolved.provider)?.get(model);
    if (record) return record;

    const legacyContext = snapshot.contextOverrides.get(resolved.provider)?.get(model);
    return legacyContext === undefined
      ? null
      : {
          provider: resolved.provider,
          modelId: model,
          realContext: legacyContext,
          source: "manual" as const,
          refreshedAt: "",
        };
  };
  const canonical = lookup(resolved.model);
  if (canonical) return canonical;
  return resolved.rawModel && resolved.rawModel !== resolved.model
    ? lookup(resolved.rawModel)
    : null;
}

export function getContextOverride(
  resolved: ResolvedCapabilityIdentity,
  snapshot?: ModelCapabilityResolutionSnapshot | null
): number | null {
  return getContextOverrideRecord(resolved, snapshot)?.realContext ?? null;
}

export function getInputTokenCapabilityOverride(
  resolved: ResolvedCapabilityIdentity,
  snapshot?: ModelCapabilityResolutionSnapshot | null
): number | null {
  return getCapabilityOverride(
    resolved,
    "max_input_tokens",
    snapshot ? (snapshot.maxInputTokenOverrides ?? new Map()) : undefined
  );
}

export function getOutputTokenCapabilityOverride(
  resolved: ResolvedCapabilityIdentity,
  snapshot?: ModelCapabilityResolutionSnapshot | null
): number | null {
  if (!snapshot) return getCapabilityOverride(resolved, "max_output_tokens");

  const current = snapshot.maxTokenOverrides ?? new Map();
  const historical = snapshot.maxOutputTokenOverrides ?? new Map();
  const canonical =
    getModelCapabilityOverride(resolved.provider, resolved.model, "max_output_tokens", current) ??
    getModelCapabilityOverride(resolved.provider, resolved.model, "max_output_tokens", historical);
  if (canonical !== null) return canonical;

  if (!resolved.rawModel || resolved.rawModel === resolved.model) return null;
  return (
    getModelCapabilityOverride(
      resolved.provider,
      resolved.rawModel,
      "max_output_tokens",
      current
    ) ??
    getModelCapabilityOverride(
      resolved.provider,
      resolved.rawModel,
      "max_output_tokens",
      historical
    )
  );
}
