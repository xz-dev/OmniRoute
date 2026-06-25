import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchSiliconFlowQuota,
  inferSiliconFlowCurrency,
  invalidateSiliconFlowQuotaCache,
  registerSiliconFlowQuotaFetcher,
  resolveSiliconFlowUserInfoUrl,
} from "../../open-sse/services/siliconflowQuotaFetcher.ts";
import { preflightQuota } from "../../open-sse/services/quotaPreflight.ts";
import {
  clearQuotaMonitors,
  getActiveMonitorCount,
  startQuotaMonitor,
  stopQuotaMonitor,
} from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearQuotaMonitors();
  clearSessions();
});

test("resolveSiliconFlowUserInfoUrl normalizes global and China base URLs", () => {
  assert.equal(resolveSiliconFlowUserInfoUrl(), "https://api.siliconflow.com/v1/user/info");
  assert.equal(
    resolveSiliconFlowUserInfoUrl("https://api.siliconflow.com/v1/chat/completions"),
    "https://api.siliconflow.com/v1/user/info"
  );
  assert.equal(
    resolveSiliconFlowUserInfoUrl("https://api.siliconflow.cn/v1"),
    "https://api.siliconflow.cn/v1/user/info"
  );
  assert.equal(
    resolveSiliconFlowUserInfoUrl("https://api.siliconflow.cn/v1/"),
    "https://api.siliconflow.cn/v1/user/info"
  );
});

test("inferSiliconFlowCurrency follows selected endpoint region", () => {
  assert.equal(inferSiliconFlowCurrency("https://api.siliconflow.cn/v1"), "CNY");
  assert.equal(inferSiliconFlowCurrency("https://api.siliconflow.com/v1"), "USD");
});

test("fetchSiliconFlowQuota returns null when no API key exists", async () => {
  const quota = await fetchSiliconFlowQuota(`siliconflow-missing-${Date.now()}`);
  assert.equal(quota, null);
});

test("fetchSiliconFlowQuota uses default global user-info endpoint", async () => {
  const connectionId = `siliconflow-global-${Date.now()}`;
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        code: 20000,
        message: "OK",
        status: true,
        data: {
          balance: "0.88",
          chargeBalance: "88.00",
          totalBalance: "88.88",
          status: "normal",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const quota = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/user/info");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sf-key");
  assert.equal(quota?.percentUsed, 0);
  assert.equal(quota?.limitReached, false);
  assert.equal((quota as any)?.balance?.currency, "USD");
  assert.equal((quota as any)?.balance?.totalBalance, 88.88);
  assert.equal((quota as any)?.balance?.balance, 0.88);
  assert.equal((quota as any)?.balance?.chargeBalance, 88);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota respects China providerSpecificData base URL", async () => {
  const connectionId = `siliconflow-cn-${Date.now()}`;
  let calledUrl = "";

  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({
        code: 20000,
        status: true,
        data: { balance: "12.34", totalBalance: "12.34", status: "normal" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const quota = await fetchSiliconFlowQuota(connectionId, {
    apiKey: "sf-key",
    providerSpecificData: { baseUrl: "https://api.siliconflow.cn/v1" },
  });

  assert.equal(calledUrl, "https://api.siliconflow.cn/v1/user/info");
  assert.equal((quota as any)?.balance?.currency, "CNY");
  assert.equal((quota as any)?.balance?.totalBalance, 12.34);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota normalizes endpoint-shaped configured base URL", async () => {
  const connectionId = `siliconflow-chat-base-${Date.now()}`;
  let calledUrl = "";

  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({ status: true, data: { totalBalance: "5.00", status: "normal" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  await fetchSiliconFlowQuota(connectionId, {
    apiKey: "sf-key",
    providerSpecificData: { baseUrl: "https://api.siliconflow.cn/v1/chat/completions" },
  });

  assert.equal(calledUrl, "https://api.siliconflow.cn/v1/user/info");

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota falls back to balance when totalBalance is absent", async () => {
  const connectionId = `siliconflow-balance-only-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: true, data: { balance: "7.50", status: "normal" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const quota = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal((quota as any)?.balance?.totalBalance, 7.5);
  assert.equal(quota?.limitReached, false);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota marks exhausted for false top-level status", async () => {
  const connectionId = `siliconflow-status-false-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: false, data: { totalBalance: "9.00", status: "normal" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal(quota?.limitReached, true);
  assert.equal(quota?.percentUsed, 1);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota marks exhausted for non-normal account status", async () => {
  const connectionId = `siliconflow-status-disabled-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: true, data: { totalBalance: "9.00", status: "disabled" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal(quota?.limitReached, true);
  assert.equal(quota?.percentUsed, 1);
  assert.equal((quota as any)?.accountStatus, "disabled");

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota marks exhausted when balance is zero", async () => {
  const connectionId = `siliconflow-zero-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: true, data: { totalBalance: "0.00", status: "normal" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal(quota?.limitReached, true);
  assert.equal(quota?.percentUsed, 1);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("fetchSiliconFlowQuota returns null on 401/403 and fail-open errors", async () => {
  const authId = `siliconflow-auth-${Date.now()}`;

  globalThis.fetch = async () => new Response(null, { status: 401 });
  assert.equal(await fetchSiliconFlowQuota(authId, { apiKey: "bad" }), null);

  globalThis.fetch = async () => new Response(null, { status: 500 });
  assert.equal(await fetchSiliconFlowQuota(`${authId}-500`, { apiKey: "sf-key" }), null);

  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchSiliconFlowQuota(`${authId}-network`, { apiKey: "sf-key" }), null);
});

test("fetchSiliconFlowQuota caches results within TTL", async () => {
  const connectionId = `siliconflow-cache-${Date.now()}`;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ status: true, data: { totalBalance: "6.00", status: "normal" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const first = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });
  const second = await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });

  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  invalidateSiliconFlowQuotaCache(connectionId);
  await fetchSiliconFlowQuota(connectionId, { apiKey: "sf-key" });
  assert.equal(calls, 2);

  invalidateSiliconFlowQuotaCache(connectionId);
});

test("registerSiliconFlowQuotaFetcher exposes SiliconFlow quota to preflight and monitor", async () => {
  const connectionId = `siliconflow-preflight-${Date.now()}`;

  registerSiliconFlowQuotaFetcher();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: true, data: { totalBalance: "0.00", status: "normal" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const preflight = await preflightQuota("siliconflow", connectionId, {
    id: connectionId,
    provider: "siliconflow",
    apiKey: "sf-key",
  });

  assert.equal(preflight.proceed, false);
  assert.equal(preflight.reason, "quota_exhausted");

  touchSession("session-1", connectionId);
  startQuotaMonitor("session-1", "siliconflow", connectionId, {
    apiKey: "sf-key",
    providerSpecificData: { quotaMonitorEnabled: true },
  });
  assert.equal(getActiveMonitorCount(), 1);
  stopQuotaMonitor("session-1");

  invalidateSiliconFlowQuotaCache(connectionId);
});
