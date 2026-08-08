export interface PricingCatalogProviderWithKey {
  pricingKey?: string;
}

export function getPricingCatalogKey(
  providerAlias: string,
  provider?: PricingCatalogProviderWithKey | string
): string {
  return (typeof provider === "string" ? provider : provider?.pricingKey) || providerAlias;
}

export function attachPricingCatalogKeys<
  T extends PricingCatalogProviderWithKey & {
    modelCount: number;
  },
>(
  catalog: Record<string, T>,
  pricingData: Record<string, unknown>
): Array<T & { alias: string; pricingKey: string; pricedModels: number }> {
  return Object.entries(catalog)
    .map(([alias, provider]) => {
      const pricingKey = getPricingCatalogKey(alias, provider);
      const models = pricingData[pricingKey];
      return {
        ...provider,
        alias,
        pricingKey,
        pricedModels: models && typeof models === "object" ? Object.keys(models).length : 0,
      };
    })
    .sort((left, right) => right.modelCount - left.modelCount);
}
