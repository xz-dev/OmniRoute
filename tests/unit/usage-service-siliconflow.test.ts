import test from "node:test";
import assert from "node:assert/strict";

import { getUsageForProvider } from "../../open-sse/services/usage.ts";
import { invalidateSiliconFlowQuotaCache } from "../../open-sse/services/siliconflowQuotaFetcher.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("getUsageForProvider handles siliconflow with valid global balance", async () => {
  let calledUrl = "";
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
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

  const result = await getUsageForProvider({
    id: "sf-usage-global",
    provider: "siliconflow",
    apiKey: "sf-key",
  });

  assert.equal(calledUrl, "https://api.siliconflow.com/v1/user/info");
  assert.equal(result.plan, "SiliconFlow");
  assert.equal(result.isAvailable, true);
  assert.equal(result.limitReached, false);
  assert.ok(result.quotas?.credits_usd);
  assert.equal(result.quotas.credits_usd.remaining, 88.88);
  assert.equal(result.quotas.credits_usd.currency, "USD");
  assert.equal(result.quotas.credits_usd.toppedUpBalance, 88);

  invalidateSiliconFlowQuotaCache("sf-usage-global");
});

test("getUsageForProvider handles siliconflow China endpoint as CNY", async () => {
  let calledUrl = "";
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({
        code: 20000,
        status: true,
        data: { balance: "10.00", totalBalance: "10.00", status: "normal" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const result = await getUsageForProvider({
    id: "sf-usage-cn",
    provider: "siliconflow",
    apiKey: "sf-key",
    providerSpecificData: { baseUrl: "https://api.siliconflow.cn/v1" },
  });

  assert.equal(calledUrl, "https://api.siliconflow.cn/v1/user/info");
  assert.equal(result.plan, "SiliconFlow");
  assert.ok(result.quotas?.credits_cny);
  assert.equal(result.quotas.credits_cny.remaining, 10);
  assert.equal(result.quotas.credits_cny.currency, "CNY");

  invalidateSiliconFlowQuotaCache("sf-usage-cn");
});

test("getUsageForProvider handles siliconflow insufficient balance", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 20000,
        status: true,
        data: { balance: "0.00", totalBalance: "0.00", status: "normal" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const result = await getUsageForProvider({
    id: "sf-usage-zero",
    provider: "siliconflow",
    apiKey: "sf-key",
  });

  assert.equal(result.plan, "SiliconFlow (Insufficient Balance)");
  assert.equal(result.isAvailable, false);
  assert.equal(result.limitReached, true);
  assert.ok(result.quotas?.credits_usd);
  assert.equal(result.quotas.credits_usd.remaining, 0);

  invalidateSiliconFlowQuotaCache("sf-usage-zero");
});

test("getUsageForProvider treats false top-level status as insufficient balance", async () => {
  const testId = "sf-usage-status-false";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 20000,
        status: false,
        data: { balance: "0.88", totalBalance: "9.50", status: "normal" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const result = await getUsageForProvider({
    id: testId,
    provider: "siliconflow",
    apiKey: "sf-key",
  });

  assert.equal(result.plan, "SiliconFlow (Insufficient Balance)");
  assert.equal(result.isAvailable, false);
  assert.equal(result.limitReached, true);
  assert.ok(result.quotas?.credits_usd);
  assert.equal(result.quotas.credits_usd.remaining, 9.5);

  invalidateSiliconFlowQuotaCache(testId);
});

test("getUsageForProvider returns message when siliconflow API key is missing", async () => {
  globalThis.fetch = async () => {
    throw new Error("Fetch should not be called");
  };

  const result = await getUsageForProvider({
    id: "sf-usage-no-key",
    provider: "siliconflow",
    apiKey: "",
  });

  assert.equal(result.message, "SiliconFlow API key not available. Add a key to view usage.");
});

test("getUsageForProvider handles siliconflow network error gracefully", async () => {
  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  const result = await getUsageForProvider({
    id: "sf-usage-network",
    provider: "siliconflow",
    apiKey: "sf-key",
  });

  assert.ok(result.message);
});
