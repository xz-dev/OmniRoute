import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo";
import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import { isPersistedResolvedLimitSource } from "@/lib/modelCapabilities";
import { buildAliasMaps, getComboTargetModelId } from "@/app/api/v1/models/catalogProviderMaps";

export type ComboContextAggregation = "min" | "max";

type ComboLike = {
  models?: unknown[];
  context_length?: number;
  context_length_aggregation?: ComboContextAggregation;
  name?: string;
};

type ProviderNodeLike = { id?: unknown; prefix?: unknown; name?: unknown };

export interface ComboContextTargetDiagnostic {
  provider: string;
  model: string;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_source?: string;
  input_source?: string;
  output_source?: string;
  unknown_reason?: string;
}

export interface ComboContextDiagnostics {
  mode: ComboContextAggregation;
  source: "manual" | "aggregated" | "unknown";
  effective_context_length?: number;
  manual_context_length?: number;
  known_min?: number;
  known_max?: number;
  known_count: number;
  targets: ComboContextTargetDiagnostic[];
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function aggregateKnownNumbers(
  values: Array<number | null | undefined>,
  mode: ComboContextAggregation = "min"
): number | undefined {
  const known = values.filter(isPositiveFiniteNumber);
  if (known.length === 0) return undefined;
  return mode === "max" ? Math.max(...known) : Math.min(...known);
}

function publicPrefix(node: ProviderNodeLike): string | null {
  if (typeof node.prefix === "string" && node.prefix.trim()) return node.prefix.trim();
  if (typeof node.name !== "string") return null;
  return (
    node.name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "") || null
  );
}

export function buildComboContextDiagnostics(
  combo: ComboLike,
  allCombos: ComboLike[],
  providerNodes: ProviderNodeLike[] = []
): ComboContextDiagnostics {
  const mode: ComboContextAggregation = combo.context_length_aggregation === "max" ? "max" : "min";
  const maps = buildAliasMaps();
  const nodePrefixes = new Map<string, string>();
  for (const node of providerNodes) {
    if (typeof node.id !== "string") continue;
    const prefix = publicPrefix(node);
    if (prefix) nodePrefixes.set(node.id, prefix);
  }

  const targets = resolveNestedComboTargets(
    combo as Parameters<typeof resolveNestedComboTargets>[0],
    allCombos as Parameters<typeof resolveNestedComboTargets>[1]
  ).map((target): ComboContextTargetDiagnostic => {
    const resolved = getComboTargetModelId(maps, target);
    if (!resolved) {
      return {
        provider: "unknown",
        model: typeof target.modelStr === "string" ? target.modelStr : "unknown",
        unknown_reason: "target-unresolved",
      };
    }

    const canonical = getCanonicalModelMetadata({
      provider: resolved.providerId,
      model: resolved.modelId,
    });
    const publicProvider =
      nodePrefixes.get(resolved.providerId) ||
      maps.providerIdToAlias[resolved.providerId] ||
      resolved.providerId;
    if (!canonical) {
      return {
        provider: publicProvider,
        model: resolved.modelId,
        unknown_reason: "metadata-unresolved",
      };
    }
    const knownSource = canonical.metadata.source;
    const hasRecognizedMetadata =
      knownSource.providerRegistry || knownSource.staticSpec || knownSource.syncedCapability;
    const hasPersistedLimit =
      (isPositiveFiniteNumber(canonical.limits.contextWindow) &&
        isPersistedResolvedLimitSource(canonical.limits.contextWindowSource)) ||
      (isPositiveFiniteNumber(canonical.limits.maxInputTokens) &&
        isPersistedResolvedLimitSource(canonical.limits.maxInputTokensSource)) ||
      (isPositiveFiniteNumber(canonical.limits.maxOutputTokens) &&
        isPersistedResolvedLimitSource(canonical.limits.maxOutputTokensSource));
    if (!hasRecognizedMetadata && !hasPersistedLimit) {
      return {
        provider: publicProvider,
        model: canonical.model || resolved.modelId,
        unknown_reason: "metadata-source-unknown",
      };
    }

    const contextLength = isPositiveFiniteNumber(canonical.limits.contextWindow)
      ? canonical.limits.contextWindow
      : undefined;
    return {
      provider: nodePrefixes.get(canonical.provider || "") || publicProvider,
      model: canonical.model || resolved.modelId,
      ...(contextLength ? { context_length: contextLength } : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxInputTokens)
        ? { max_input_tokens: canonical.limits.maxInputTokens }
        : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxOutputTokens)
        ? { max_output_tokens: canonical.limits.maxOutputTokens }
        : {}),
      ...(contextLength
        ? { context_source: canonical.limits.contextWindowSource || "authoritative-fallback" }
        : { unknown_reason: "context-limit-unknown" }),
      ...(isPositiveFiniteNumber(canonical.limits.maxInputTokens) &&
      canonical.limits.maxInputTokensSource
        ? { input_source: canonical.limits.maxInputTokensSource }
        : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxOutputTokens) &&
      canonical.limits.maxOutputTokensSource
        ? { output_source: canonical.limits.maxOutputTokensSource }
        : {}),
    };
  });

  const contexts = targets.map((target) => target.context_length);
  const knownCount = contexts.filter(isPositiveFiniteNumber).length;
  const manual = isPositiveFiniteNumber(combo.context_length) ? combo.context_length : undefined;
  const effective = manual ?? aggregateKnownNumbers(contexts, mode);
  return {
    mode,
    source: manual ? "manual" : effective ? "aggregated" : "unknown",
    ...(effective ? { effective_context_length: effective } : {}),
    ...(manual ? { manual_context_length: manual } : {}),
    ...(knownCount > 0 ? { known_min: aggregateKnownNumbers(contexts, "min") } : {}),
    ...(knownCount > 0 ? { known_max: aggregateKnownNumbers(contexts, "max") } : {}),
    known_count: knownCount,
    targets,
  };
}

export function computeComboContextLength(combo: ComboLike, allCombos: ComboLike[]) {
  return buildComboContextDiagnostics(combo, allCombos).effective_context_length;
}
