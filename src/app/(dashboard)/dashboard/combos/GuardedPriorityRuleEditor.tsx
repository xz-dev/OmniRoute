import { useTranslations } from "next-intl";
import OfflineRuleEditor from "./OfflineRuleEditor";
import type { OfflineRuleStep } from "@/lib/combos/offlineRuleDraft";

function getI18nOrFallback(
  t: ReturnType<typeof useTranslations>,
  key: string,
  fallback: string
): string {
  try {
    if (typeof t.has === "function" && t.has(key)) return t(key);
  } catch {}
  return fallback;
}

export default function GuardedPriorityRuleEditor({
  step,
  error,
  onChange,
  onErrorChange,
}: {
  step: OfflineRuleStep;
  error?: string | null;
  onChange: (step: OfflineRuleStep) => void;
  onErrorChange: (error: string | null) => void;
}) {
  const t = useTranslations("combos");

  return (
    <>
      <OfflineRuleEditor
        step={step}
        onChange={onChange}
        onErrorChange={onErrorChange}
        labels={{
          enabled: getI18nOrFallback(t, "offlineRuleEnabled", "Hard Offline condition"),
          condition: getI18nOrFallback(
            t,
            "offlineRuleCondition",
            "Safe JSON Logic (advanced/custom condition)"
          ),
          cooldown: getI18nOrFallback(t, "offlineRuleCooldown", "Cooldown (ms)"),
          help: getI18nOrFallback(
            t,
            "offlineRuleHelp",
            "Default: 300000 ms (5 minutes). A non-matching response never falls through."
          ),
        }}
      />
      {error && <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">{error}</p>}
    </>
  );
}
