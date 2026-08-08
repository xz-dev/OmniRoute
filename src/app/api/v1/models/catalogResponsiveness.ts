import {
  AUTO_TEMPLATE_VARIANTS,
  AUTO_SUFFIX_VARIANTS,
  AUTO_FAMILY_IDS,
  createBuiltinAutoCombo,
  prepareBuiltinAutoComboInputs,
  isPaidTierAutoId,
} from "@omniroute/open-sse/services/autoCombo/builtinCatalog";
import { getModelsDevPricing } from "@/lib/modelsDevSync";
import type { CatalogEnrichmentSnapshot } from "@/lib/modelMetadataRegistry";

const BUILTIN_AUTO_YIELD_INTERVAL = 8;

function yieldCatalogBuildTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function appendBuiltinAutoCatalogModels(options: {
  blockedProviders: ReadonlySet<string>;
  hideAuto: boolean;
  hidePaid: boolean;
  listedIds: Set<string>;
  models: Array<Record<string, unknown>>;
  timestamp: number;
}): Promise<void> {
  if (options.hideAuto) return;

  let preparedAutoInputs: Awaited<ReturnType<typeof prepareBuiltinAutoComboInputs>> | undefined;
  let materializedAutoCount = 0;
  for (const autoId of [
    ...Object.keys(AUTO_TEMPLATE_VARIANTS),
    ...AUTO_SUFFIX_VARIANTS,
    ...AUTO_FAMILY_IDS,
  ]) {
    if (options.blockedProviders.has("auto") || options.listedIds.has(autoId)) continue;
    if (options.hidePaid && isPaidTierAutoId(autoId)) continue;
    options.listedIds.add(autoId);
    const baseAutoEntry: Record<string, unknown> = {
      id: autoId,
      object: "model",
      created: options.timestamp,
      owned_by: "combo",
      permission: [],
      root: autoId,
      parent: null,
    };
    try {
      const suffix = autoId.replace(/^auto\/?/, "");
      if (!preparedAutoInputs) {
        preparedAutoInputs = await prepareBuiltinAutoComboInputs();
        await yieldCatalogBuildTurn();
      }
      const virtualCombo = await createBuiltinAutoCombo(autoId, suffix, preparedAutoInputs);
      const contextLength = virtualCombo.advertisedContextLength || 128000;
      const maxOutputTokens = virtualCombo.advertisedMaxOutputTokens || 8192;
      options.models.push({
        ...baseAutoEntry,
        context_length: contextLength,
        max_input_tokens: contextLength,
        max_output_tokens: maxOutputTokens,
        capabilities: {
          tool_calling: true,
          reasoning: true,
          thinking: true,
          temperature: true,
        },
      });
    } catch (err) {
      console.log(`[catalog] Could not materialize built-in auto model ${autoId}:`, err);
      options.models.push(baseAutoEntry);
    }

    materializedAutoCount++;
    if (materializedAutoCount % BUILTIN_AUTO_YIELD_INTERVAL === 0) {
      await yieldCatalogBuildTurn();
    }
  }
}

export async function prepareCatalogEnrichmentSnapshot(
  finalModels: Array<{ owned_by?: unknown }>
): Promise<CatalogEnrichmentSnapshot | undefined> {
  if (!finalModels.some((model) => model.owned_by !== "combo")) return undefined;

  let modelsDevPricing: ReturnType<typeof getModelsDevPricing> | null = null;
  try {
    modelsDevPricing = getModelsDevPricing();
  } catch {
    // Pricing lookup is optional; hardcoded defaults still enrich the response.
  }
  const snapshot = { modelsDevPricing };
  // Yield before the remaining in-memory enrichment and JSON serialization.
  await yieldCatalogBuildTurn();
  return snapshot;
}
