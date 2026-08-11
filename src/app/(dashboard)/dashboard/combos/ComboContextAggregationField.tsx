"use client";

import { useTranslations } from "next-intl";

export type ComboContextAggregation = "min" | "max";

export function ComboContextAggregationField({
  value = "min",
  onChange,
  manualValue,
  onManualValueChange,
  error,
}: {
  value?: ComboContextAggregation;
  onChange: (value: ComboContextAggregation) => void;
  manualValue?: number;
  onManualValueChange?: (value: number | undefined) => void;
  error?: string;
}) {
  const t = useTranslations("combos");
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <label
          htmlFor="combo-manual-context-length"
          className="text-[11px] font-medium text-text-muted block mb-0.5"
        >
          {t("agentFeaturesContextLength")}
        </label>
        <input
          id="combo-manual-context-length"
          type="number"
          min="1000"
          max="2000000"
          step="1000"
          value={manualValue || ""}
          onChange={(event) =>
            onManualValueChange?.(event.target.value ? Number(event.target.value) : undefined)
          }
          className="w-full text-xs py-1.5 px-2 rounded border border-black/10 dark:border-white/10 bg-transparent focus:border-primary focus:outline-none"
        />
        {error ? (
          <p className="text-[10px] text-red-500 mt-0.5">{error}</p>
        ) : (
          <p className="text-[10px] text-text-muted mt-0.5">
            {t("agentFeaturesContextLengthHint")}
          </p>
        )}
      </div>
      <div>
        <label
          htmlFor="combo-context-aggregation"
          className="text-[11px] font-medium text-text-muted block mb-0.5"
        >
          {t("contextAggregationLabel")}
        </label>
        <select
          id="combo-context-aggregation"
          data-testid="combo-context-aggregation"
          value={value}
          onChange={(event) => onChange(event.target.value as ComboContextAggregation)}
          className="w-full text-xs py-1.5 px-2 rounded border border-black/10 dark:border-white/10 bg-transparent focus:border-primary focus:outline-none"
        >
          <option value="min">{t("contextAggregationMin")}</option>
          <option value="max">{t("contextAggregationMax")}</option>
        </select>
        {value === "max" && (
          <p
            data-testid="combo-context-max-warning"
            className="text-[10px] text-amber-700 dark:text-amber-300 mt-0.5"
          >
            {t("contextAggregationWarning")}
          </p>
        )}
      </div>
    </div>
  );
}
