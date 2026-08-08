import test from "node:test";
import assert from "node:assert/strict";
import {
  attachPricingCatalogKeys,
  getPricingCatalogKey,
} from "../../src/lib/pricingCatalogKeys.ts";

test("pricing catalog keys keep public aliases separate from pricing namespaces", () => {
  const catalog = {
    public: {
      id: "openai-compatible-chat-node",
      modelCount: 2,
      pricingKey: "private-pricing-namespace",
    },
    openai: { id: "openai", modelCount: 1 },
  };
  const result = attachPricingCatalogKeys(catalog, {
    "private-pricing-namespace": { a: {}, b: {} },
    openai: { c: {} },
  });

  assert.deepEqual(
    result.map(({ alias, pricingKey, pricedModels }) => ({ alias, pricingKey, pricedModels })),
    [
      { alias: "public", pricingKey: "private-pricing-namespace", pricedModels: 2 },
      { alias: "openai", pricingKey: "openai", pricedModels: 1 },
    ]
  );
  assert.equal(
    getPricingCatalogKey("public", "private-pricing-namespace"),
    "private-pricing-namespace"
  );
});
