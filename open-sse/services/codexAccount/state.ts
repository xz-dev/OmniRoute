import { getCodexModelScope, type CodexQuotaScope } from "../../config/codexQuotaScopes.ts";
import type {
  CodexAccountConnection,
  CodexAccountPool,
  CodexAccountPoolState,
  CodexChildAccount,
  CodexChildAccountState,
  CodexChildCooldown,
  CodexParentAccount,
  CodexAccountState,
  CodexAccount,
} from "./types.ts";

const CODEX_SCOPES: readonly CodexQuotaScope[] = ["codex", "spark"];

type LegacyStateOwner = Pick<CodexAccountConnection, "providerSpecificData">;

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function getLegacyCooldownMap(connection: LegacyStateOwner): Readonly<Record<string, unknown>> {
  return asRecord(connection.providerSpecificData.codexScopeRateLimitedUntil);
}

function getLegacyCooldown(account: CodexChildAccount): string | null {
  const value = getLegacyCooldownMap(account.connection)[account.scope];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseFutureTimestamp(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const timestampMs = new Date(value).getTime();
  return Number.isFinite(timestampMs) && timestampMs > nowMs ? timestampMs : null;
}

function resolveChild(pool: CodexAccountPool, model: string): CodexChildAccount {
  const scope = getCodexModelScope(model);
  return pool.children.find((account) => account.scope === scope) ?? pool.children[0];
}

/** Inspect the read-only parent aggregate without exposing legacy storage parsing. */
export function inspectCodexAccount(
  pool: CodexAccountPool,
  account: CodexParentAccount,
  nowMs?: number
): CodexAccountPoolState;
/** Inspect one scoped child without exposing legacy storage parsing. */
export function inspectCodexAccount(
  pool: CodexAccountPool,
  account: CodexChildAccount,
  nowMs?: number
): CodexChildAccountState;
/** Inspect a runtime-selected parent or child account. */
export function inspectCodexAccount(
  pool: CodexAccountPool,
  account: CodexAccount,
  nowMs?: number
): CodexAccountState;
export function inspectCodexAccount(
  pool: CodexAccountPool,
  account: CodexParentAccount | CodexChildAccount,
  nowMs = Date.now()
): CodexAccountPoolState | CodexChildAccountState {
  if (account.connectionId !== pool.parent.connectionId) {
    throw new Error("Codex account does not belong to this pool");
  }
  if (account.kind === "parent") return getCodexAccountPoolState(pool, nowMs);
  const rateLimitedUntil = getLegacyCooldown(account);
  return {
    kind: "child",
    scope: account.scope,
    rateLimitedUntil,
    unavailable: parseFutureTimestamp(rateLimitedUntil, nowMs) !== null,
  };
}

/** Return the earliest active child cooldown for a model across account pools. */
export function getEarliestCodexChildCooldown(
  pools: readonly CodexAccountPool[],
  model: string | null | undefined,
  nowMs = Date.now()
): CodexChildCooldown | null {
  if (typeof model !== "string" || model.trim().length === 0) return null;
  let earliest: CodexChildCooldown | null = null;
  let earliestMs = Infinity;
  for (const pool of pools) {
    const child = resolveChild(pool, model);
    const until = getLegacyCooldown(child);
    const timestampMs = parseFutureTimestamp(until, nowMs);
    if (timestampMs !== null && timestampMs < earliestMs && until !== null) {
      earliest = { account: child, until };
      earliestMs = timestampMs;
    }
  }
  return earliest;
}

/** Aggregate the two virtual child states as a read-only parent view. */
export function getCodexAccountPoolState(
  pool: CodexAccountPool,
  nowMs = Date.now()
): CodexAccountPoolState {
  const limitedScopes = CODEX_SCOPES.filter((scope) => {
    const child = pool.children.find((account) => account.scope === scope);
    if (!child) return false;
    const until = getLegacyCooldown(child);
    return parseFutureTimestamp(until, nowMs) !== null;
  });

  return {
    kind: "parent",
    status:
      limitedScopes.length === 0
        ? "available"
        : limitedScopes.length === CODEX_SCOPES.length
          ? "fully_limited"
          : "partially_limited",
    limitedScopes,
  };
}
