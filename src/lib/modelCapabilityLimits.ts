import type { ModelContextOverrideSource } from "@/lib/db/modelContextOverrides";
import type { ModelCapabilityResolutionSnapshot } from "@/lib/modelCapabilityResolutionSnapshot";

export function isResolutionSnapshot(
  value:
    | { persistedOverrides?: boolean; snapshot?: ModelCapabilityResolutionSnapshot | null }
    | ModelCapabilityResolutionSnapshot
    | undefined
): value is ModelCapabilityResolutionSnapshot {
  return !!value && "synced" in value && "contextOverrides" in value;
}

export type ResolvedLimitSource =
  | ModelContextOverrideSource
  | "capability-override"
  | "authoritative-fallback"
  | "synced"
  | "registry"
  | "spec";

export function isPersistedResolvedLimitSource(source: ResolvedLimitSource | null): boolean {
  return source === "manual" || source === "auto:discovery" || source === "capability-override";
}

export function resolveClampedMaxInputLimit(input: {
  override: number | null;
  registry: number | null;
  authoritative: number | null;
  synced: number | null;
  contextWindow: number | null;
  contextWindowSource: ResolvedLimitSource | null;
}): { value: number | null; source: ResolvedLimitSource | null } {
  const value =
    input.override ?? input.registry ?? input.authoritative ?? input.synced ?? input.contextWindow;
  const source: ResolvedLimitSource | null =
    input.override !== null
      ? "capability-override"
      : input.registry !== null
        ? "registry"
        : input.authoritative !== null
          ? "authoritative-fallback"
          : input.synced !== null
            ? "synced"
            : input.contextWindowSource;

  return value !== null && input.contextWindow !== null && value > input.contextWindow
    ? { value: input.contextWindow, source: input.contextWindowSource }
    : { value, source };
}
