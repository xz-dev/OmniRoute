/**
 * siliconflowQuotaFetcher.ts — SiliconFlow Balance Quota Fetcher
 *
 * Implements QuotaFetcher for the SiliconFlow provider (quotaPreflight.ts + quotaMonitor.ts).
 *
 * SiliconFlow provides a user-info API on both international and China endpoints:
 *   GET https://api.siliconflow.com/v1/user/info
 *   GET https://api.siliconflow.cn/v1/user/info
 *
 * Response format (official docs):
 *   {
 *     "code": 20000,
 *     "message": "OK",
 *     "status": true,
 *     "data": {
 *       "balance": "0.88",
 *       "chargeBalance": "88.00",
 *       "totalBalance": "88.88",
 *       "status": "normal"
 *     }
 *   }
 *
 * The public API exposes legacy credit-balance fields. SiliconFlow's dashboard
 * has moved pre-2025-11-30 credits into vouchers, so totalBalance can be
 * negative while the account remains normal and has usable voucher balance.
 * Treat only explicit API/account status failures as exhausted.
 *
 * Cache: in-memory TTL (60s) to avoid hammering the user-info API on every request.
 *
 * Registration: call registerSiliconFlowQuotaFetcher() once at server startup.
 */

import { registerQuotaFetcher, type QuotaInfo } from "./quotaPreflight.ts";
import { registerMonitorFetcher } from "./quotaMonitor.ts";

const SILICONFLOW_DEFAULT_BASE_URL = "https://api.siliconflow.com/v1";
const CACHE_TTL_MS = 60_000;

export interface SiliconFlowBalanceInfo {
  currency: string;
  balance: number;
  chargeBalance: number | null;
  totalBalance: number;
  displayBalance: number;
  accountStatus: string | null;
}

export interface SiliconFlowQuota extends QuotaInfo {
  balance: SiliconFlowBalanceInfo;
  isAvailable: boolean;
  limitReached: boolean;
  accountStatus: string | null;
}

interface CacheEntry {
  quota: SiliconFlowQuota;
  fetchedAt: number;
}

const quotaCache = new Map<string, CacheEntry>();

const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 60_000);

if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeConfiguredBaseUrl(baseUrl: unknown): string {
  const raw =
    typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : SILICONFLOW_DEFAULT_BASE_URL;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function versionRootPath(pathname: string): string {
  const segments = pathSegments(pathname);
  const versionIndex = segments.findIndex((segment) => /^v\d+(?:beta)?$/i.test(segment));

  if (versionIndex >= 0) {
    return `/${segments.slice(0, versionIndex + 1).join("/")}`;
  }

  if (segments.length === 0) return "/v1";

  const withoutKnownEndpoint = [...segments];
  const tail = withoutKnownEndpoint.slice(-2).join("/").toLowerCase();
  if (["chat/completions", "user/info"].includes(tail)) {
    withoutKnownEndpoint.splice(-2, 2);
  } else if (["models", "responses"].includes(String(withoutKnownEndpoint.at(-1)).toLowerCase())) {
    withoutKnownEndpoint.pop();
  }

  return withoutKnownEndpoint.length > 0 ? `/${withoutKnownEndpoint.join("/")}` : "/v1";
}

export function resolveSiliconFlowUserInfoUrl(baseUrl?: unknown): string {
  try {
    const url = new URL(normalizeConfiguredBaseUrl(baseUrl));
    const rootPath = versionRootPath(url.pathname).replace(/\/+$/, "") || "/v1";
    return `${url.origin}${rootPath}/user/info`;
  } catch {
    return `${SILICONFLOW_DEFAULT_BASE_URL}/user/info`;
  }
}

export function inferSiliconFlowCurrency(baseUrl?: unknown): string {
  try {
    const url = new URL(normalizeConfiguredBaseUrl(baseUrl));
    return url.hostname.toLowerCase().endsWith(".cn") ? "CNY" : "USD";
  } catch {
    return "USD";
  }
}

function isHealthyAccountStatus(status: unknown): boolean {
  if (typeof status !== "string" || status.trim().length === 0) return true;
  return new Set(["normal", "active", "enabled", "ok"]).has(status.trim().toLowerCase());
}

function parseSiliconFlowQuotaResponse(data: unknown, currency: string): SiliconFlowQuota | null {
  const root = toRecord(data);
  const payload = Object.keys(toRecord(root.data)).length > 0 ? toRecord(root.data) : root;

  const totalBalance = toNumberOrNull(payload.totalBalance ?? payload.total_balance);
  const balance = toNumberOrNull(payload.balance);
  const chargeBalance = toNumberOrNull(payload.chargeBalance ?? payload.charge_balance);
  const effectiveBalance = totalBalance ?? balance ?? chargeBalance;

  if (effectiveBalance === null) return null;

  const rootStatusOk = root.status !== false;
  const accountStatus = typeof payload.status === "string" ? payload.status : null;
  const accountStatusOk = isHealthyAccountStatus(accountStatus);
  const limitReached = !rootStatusOk || !accountStatusOk;
  const percentUsed = limitReached ? 1 : 0;
  const displayBalance =
    effectiveBalance < 0 && !limitReached ? Math.max(balance ?? 0, 0) : effectiveBalance;

  return {
    used: percentUsed * 100,
    total: 100,
    percentUsed,
    resetAt: null,
    balance: {
      currency,
      balance: balance ?? effectiveBalance,
      chargeBalance,
      totalBalance: effectiveBalance,
      displayBalance,
      accountStatus,
    },
    isAvailable: !limitReached,
    limitReached,
    accountStatus,
  };
}

function getProviderSpecificData(connection?: Record<string, unknown>): Record<string, unknown> {
  return toRecord(connection?.providerSpecificData);
}

export async function fetchSiliconFlowQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  const cached = quotaCache.get(connectionId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.quota;
  }

  const apiKey =
    typeof connection?.apiKey === "string" && connection.apiKey.trim().length > 0
      ? connection.apiKey.trim()
      : null;

  if (!apiKey) return null;

  const providerSpecificData = getProviderSpecificData(connection);
  const baseUrl = providerSpecificData.baseUrl;
  const url = resolveSiliconFlowUserInfoUrl(baseUrl);
  const currency = inferSiliconFlowCurrency(baseUrl);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.status === 401 || response.status === 403) {
      quotaCache.delete(connectionId);
      return null;
    }

    if (!response.ok) return null;

    const data = await response.json();
    const quota = parseSiliconFlowQuotaResponse(data, currency);
    if (!quota) return null;

    quotaCache.set(connectionId, { quota, fetchedAt: Date.now() });
    return quota;
  } catch {
    return null;
  }
}

export function invalidateSiliconFlowQuotaCache(connectionId: string): void {
  quotaCache.delete(connectionId);
}

export function registerSiliconFlowQuotaFetcher(): void {
  registerQuotaFetcher("siliconflow", fetchSiliconFlowQuota);
  registerMonitorFetcher("siliconflow", fetchSiliconFlowQuota);
}
