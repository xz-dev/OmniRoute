import type { ModelAvailabilityResult } from "@omniroute/open-sse/services/combo/types.ts";

/**
 * Minimal credential-lookup surface used by model pre-dispatch checks.
 * Intentionally duck-typed so auth return shapes can evolve without cycles.
 */
export type CredentialAvailabilityLookup = {
  allRateLimited?: boolean;
  quotaExhaustedConnectionIds?: unknown;
  retryAfter?: unknown;
};

/**
 * Normalize a credential preflight result into ModelAvailabilityResult.
 *
 * - missing credentials → false (generic pre-dispatch unavailability)
 * - allRateLimited with authoritative quota-exhausted IDs → structured result
 * - allRateLimited without those IDs → false (cooldown/cap/circuit/unknown)
 * - otherwise → true (caller may cache credentials for dispatch)
 */
export function normalizeCredentialAvailability(
  creds: CredentialAvailabilityLookup | null | undefined
): ModelAvailabilityResult {
  if (!creds) return false;
  if (!creds.allRateLimited) return true;

  // Propagate only authoritative local quota-preflight exhaustion IDs.
  // Generic allRateLimited (cooldown, concurrent-cap, circuit, missing
  // credentials) remains a plain false so Guarded Priority does not advance.
  const exhaustedIds = Array.isArray(creds.quotaExhaustedConnectionIds)
    ? creds.quotaExhaustedConnectionIds.filter(
        (id: unknown): id is string => typeof id === "string" && id.trim().length > 0
      )
    : [];
  if (exhaustedIds.length > 0) {
    return {
      available: false as const,
      reason: "quota-exhausted" as const,
      quotaExhaustedConnectionIds: exhaustedIds,
      retryAfter: typeof creds.retryAfter === "string" ? creds.retryAfter : null,
    };
  }
  return false;
}
