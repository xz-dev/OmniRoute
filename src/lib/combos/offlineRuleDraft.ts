import { validateOfflineCondition } from "@omniroute/open-sse/services/combo/offlineRule.ts";
import { getComboStepTarget } from "@/lib/combos/steps";
import { MAX_TIMER_TIMEOUT_MS } from "@/shared/utils/runtimeTimeouts";

export const DEFAULT_OFFLINE_CONDITION = { "omniroute.accountUnavailable": [] } as const;
export const DEFAULT_OFFLINE_COOLDOWN_MS = 300_000;
export const MAX_OFFLINE_COOLDOWN_MS = MAX_TIMER_TIMEOUT_MS;

export function applyGuardedPriorityStrategyTransition<T extends OfflineRuleStep>(
  previousStrategy: string,
  nextStrategy: string,
  models: T[],
  config: Record<string, unknown>
): { models: T[]; config: Record<string, unknown>; clearedRules: boolean } {
  const clearedRules = previousStrategy === "guarded-priority" && nextStrategy !== previousStrategy;
  if (nextStrategy !== "guarded-priority") {
    return { models: clearedRules ? clearOfflineRules(models) : models, config, clearedRules };
  }
  const shadowRouting =
    config.shadowRouting &&
    typeof config.shadowRouting === "object" &&
    !Array.isArray(config.shadowRouting)
      ? config.shadowRouting
      : {};
  return {
    models,
    config: {
      ...config,
      nestedComboMode: "execute",
      hedging: false,
      shadowRouting: { ...shadowRouting, enabled: false },
    },
    clearedRules,
  };
}

export type OfflineRuleStep = {
  id?: string;
  kind?: string;
  model?: string;
  comboName?: string;
  weight?: number;
  offlineCondition?: unknown;
  offlineCooldownMs?: number;
  [key: string]: unknown;
};

let nextOfflineRuleStepId = 0;

export function createOfflineRuleStepId(): string {
  nextOfflineRuleStepId += 1;
  return `offline-step-new-${nextOfflineRuleStepId}`;
}

export function ensureOfflineRuleStepIds<T extends OfflineRuleStep>(
  steps: T[],
  createId: () => string = createOfflineRuleStepId
): T[] {
  const used = new Set<string>();
  return steps.map((step) => {
    let id = typeof step.id === "string" ? step.id : "";
    if (!id || used.has(id)) {
      do id = createId();
      while (!id || used.has(id));
    }
    used.add(id);
    return step.id === id ? step : { ...step, id };
  });
}

export function normalizeOfflineRuleModelEntry(entry: unknown, index = 0): OfflineRuleStep {
  if (typeof entry === "string") {
    return { id: `offline-step-${index}`, model: entry, weight: 0 };
  }
  const step = entry && typeof entry === "object" ? (entry as OfflineRuleStep) : {};
  const id = typeof step.id === "string" && step.id ? step.id : `offline-step-${index}`;
  if (step.kind === "combo-ref") {
    return { ...step, id, model: step.comboName, weight: step.weight || 0 };
  }
  if (step.kind === "provider-wildcard") {
    const providerId = typeof step.providerId === "string" ? step.providerId.trim() : "";
    const modelPattern = typeof step.modelPattern === "string" ? step.modelPattern.trim() : "";
    const model = providerId ? `${providerId}/${modelPattern || "*"}` : getComboStepTarget(step);
    return { ...step, id, model, weight: step.weight || 0 };
  }
  return { ...step, id, model: step.model, weight: step.weight || 0 };
}

export type OfflineRuleDraftResult =
  { success: true; condition: unknown; cooldownMs: number } | { success: false; error: string };

export type OfflineRuleDraftErrors = Record<string, string>;

export function hasActiveOfflineRuleDraftError(
  steps: OfflineRuleStep[],
  errors: OfflineRuleDraftErrors
): boolean {
  const activeStepIds = new Set(steps.map((step) => String(step.id)));
  return Object.entries(errors).some(([stepId, error]) => activeStepIds.has(stepId) && !!error);
}

export function clearOfflineRuleDraftError(
  errors: OfflineRuleDraftErrors,
  stepId: string
): OfflineRuleDraftErrors {
  if (!errors[stepId]) return errors;
  const next = { ...errors };
  delete next[stepId];
  return next;
}

export function hasOfflineRule(step: OfflineRuleStep): boolean {
  return step.offlineCondition !== undefined || step.offlineCooldownMs !== undefined;
}

export function formatOfflineCondition(condition: unknown): string {
  if (condition === undefined) return JSON.stringify(DEFAULT_OFFLINE_CONDITION, null, 2);
  try {
    return JSON.stringify(condition, null, 2);
  } catch {
    return "";
  }
}

export function validateOfflineRuleStep(step: OfflineRuleStep): string | null {
  const hasCondition = step.offlineCondition !== undefined;
  const hasCooldown = step.offlineCooldownMs !== undefined;
  if (!hasCondition && !hasCooldown) return null;
  if (!hasCondition || !hasCooldown) {
    return "Condition and cooldown must be configured together.";
  }
  try {
    validateOfflineCondition(step.offlineCondition);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid offline condition.";
  }
  const cooldownMs = step.offlineCooldownMs;
  if (
    typeof cooldownMs !== "number" ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 0 ||
    cooldownMs > MAX_OFFLINE_COOLDOWN_MS
  ) {
    return `Cooldown must be a whole number from 0 to ${MAX_OFFLINE_COOLDOWN_MS} ms.`;
  }
  return null;
}

export function parseOfflineRuleDraft(
  conditionText: string,
  cooldownText: string
): OfflineRuleDraftResult {
  let condition: unknown;
  try {
    condition = JSON.parse(conditionText);
  } catch {
    return { success: false, error: "Condition must be valid JSON." };
  }

  try {
    validateOfflineCondition(condition);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid offline condition.",
    };
  }

  if (!/^\d+$/.test(cooldownText.trim())) {
    return { success: false, error: "Cooldown must be a whole number of milliseconds." };
  }
  const cooldownMs = Number(cooldownText);
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs > MAX_OFFLINE_COOLDOWN_MS) {
    return {
      success: false,
      error: `Cooldown must be between 0 and ${MAX_OFFLINE_COOLDOWN_MS} ms.`,
    };
  }

  return { success: true, condition, cooldownMs };
}

export function validateHardOfflineParent(
  steps: OfflineRuleStep[],
  strategy: string,
  config: Record<string, unknown>
): string | null {
  const hasRule = steps.some(hasOfflineRule);
  if (strategy !== "guarded-priority") {
    return hasRule ? "Hard offline rules require Guarded Priority strategy." : null;
  }
  if (!hasRule) return "Guarded Priority requires at least one Hard Offline condition.";
  if (config.nestedComboMode !== "execute") {
    return "Hard offline rules require Execute nested combo behavior.";
  }
  if (config.hedging === true) return "Hard offline rules cannot use hedging.";
  const shadowRouting = config.shadowRouting;
  if (
    shadowRouting &&
    typeof shadowRouting === "object" &&
    !Array.isArray(shadowRouting) &&
    (shadowRouting as { enabled?: unknown }).enabled === true
  ) {
    return "Hard offline rules cannot use shadow routing.";
  }
  return null;
}

export function clearOfflineRules<T extends OfflineRuleStep>(steps: T[]): T[] {
  return steps.map((step) => setOfflineRuleEnabled(step, false));
}

export function setOfflineRuleEnabled<T extends OfflineRuleStep>(step: T, enabled: boolean): T {
  if (!enabled) {
    const { offlineCondition: _condition, offlineCooldownMs: _cooldown, ...rest } = step;
    return rest as T;
  }
  return {
    ...step,
    offlineCondition: step.offlineCondition ?? DEFAULT_OFFLINE_CONDITION,
    offlineCooldownMs: step.offlineCooldownMs ?? DEFAULT_OFFLINE_COOLDOWN_MS,
  };
}
