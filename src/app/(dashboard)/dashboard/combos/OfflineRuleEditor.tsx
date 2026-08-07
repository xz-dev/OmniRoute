import { useState } from "react";
import {
  formatOfflineCondition,
  hasOfflineRule,
  MAX_OFFLINE_COOLDOWN_MS,
  parseOfflineRuleDraft,
  setOfflineRuleEnabled,
  type OfflineRuleStep,
} from "@/lib/combos/offlineRuleDraft";

export default function OfflineRuleEditor({
  step,
  onChange,
  onErrorChange,
  labels,
}: {
  step: OfflineRuleStep;
  onChange: (step: OfflineRuleStep) => void;
  onErrorChange?: (error: string | null) => void;
  labels: {
    enabled: string;
    condition: string;
    cooldown: string;
    help: string;
  };
}) {
  const fieldPrefix = `offline-rule-${step.id}`;
  const conditionId = `${fieldPrefix}-condition`;
  const cooldownId = `${fieldPrefix}-cooldown`;
  const enabled = hasOfflineRule(step);
  const [conditionText, setConditionText] = useState(() =>
    formatOfflineCondition(step.offlineCondition)
  );
  const [cooldownText, setCooldownText] = useState(() =>
    step.offlineCooldownMs === undefined ? "" : String(step.offlineCooldownMs)
  );
  const [error, setError] = useState<string | null>(null);

  const applyDraft = (nextConditionText: string, nextCooldownText: string) => {
    const result = parseOfflineRuleDraft(nextConditionText, nextCooldownText);
    if (result.success === false) {
      setError(result.error);
      onErrorChange?.(result.error);
      return;
    }
    setError(null);
    onErrorChange?.(null);
    onChange({
      ...step,
      offlineCondition: result.condition,
      offlineCooldownMs: result.cooldownMs,
    });
  };

  return (
    <div className="mt-2 border-t border-black/5 pt-2 dark:border-white/5">
      <label className="flex items-center gap-2 text-[10px] text-text-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const nextStep = setOfflineRuleEnabled(step, event.target.checked);
            setConditionText(formatOfflineCondition(nextStep.offlineCondition));
            setCooldownText(
              nextStep.offlineCooldownMs === undefined ? "" : String(nextStep.offlineCooldownMs)
            );
            setError(null);
            onErrorChange?.(null);
            onChange(nextStep);
          }}
        />
        {labels.enabled}
      </label>
      {enabled && (
        <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
          <div>
            <label
              htmlFor={conditionId}
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-muted"
            >
              {labels.condition}
            </label>
            <textarea
              id={conditionId}
              value={conditionText}
              rows={4}
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                setConditionText(next);
                applyDraft(next, cooldownText);
              }}
              className={`w-full rounded border bg-transparent px-2 py-1.5 font-mono text-[11px] focus:outline-none ${
                error
                  ? "border-red-500/60 focus:border-red-500"
                  : "border-black/10 focus:border-primary dark:border-white/10"
              }`}
            />
          </div>
          <div>
            <label
              htmlFor={cooldownId}
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-muted"
            >
              {labels.cooldown}
            </label>
            <input
              id={cooldownId}
              type="number"
              min="0"
              max={MAX_OFFLINE_COOLDOWN_MS}
              step="1000"
              value={cooldownText}
              onChange={(event) => {
                const next = event.target.value;
                setCooldownText(next);
                applyDraft(conditionText, next);
              }}
              className={`w-full rounded border bg-transparent px-2 py-1.5 text-xs focus:outline-none ${
                error
                  ? "border-red-500/60 focus:border-red-500"
                  : "border-black/10 focus:border-primary dark:border-white/10"
              }`}
            />
            <p className="mt-1 text-[10px] text-text-muted">{labels.help}</p>
          </div>
          {error && (
            <p className="text-[10px] text-red-600 dark:text-red-400 md:col-span-2" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
