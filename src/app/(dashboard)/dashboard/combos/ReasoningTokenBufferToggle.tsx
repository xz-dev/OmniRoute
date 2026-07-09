import Tooltip from "@/shared/components/Tooltip";

type TranslationFn = {
  (key: string): string;
  has?: (key: string) => boolean;
};

type Props = {
  config: Record<string, any>;
  setConfig: (config: Record<string, any>) => void;
  t: TranslationFn;
};

function getI18nOrFallback(t: TranslationFn, key: string, fallback: string): string {
  try {
    if (typeof t.has === "function" && t.has(key)) return t(key);
  } catch {}
  return fallback;
}

export default function ReasoningTokenBufferToggle({ config, setConfig, t }: Props) {
  return (
    <div className="flex items-center gap-2 py-1">
      <input
        type="checkbox"
        id="reasoningTokenBufferEnabled"
        data-testid="combo-reasoning-token-buffer-enabled"
        checked={config.reasoningTokenBufferEnabled === true}
        onChange={(e) => setConfig({ ...config, reasoningTokenBufferEnabled: e.target.checked })}
        className="w-3.5 h-3.5 rounded border border-black/20 dark:border-white/20 accent-primary cursor-pointer"
      />
      <label
        htmlFor="reasoningTokenBufferEnabled"
        className="text-xs text-text-muted cursor-pointer select-none"
      >
        {getI18nOrFallback(t, "reasoningTokenBuffer", "Reasoning token buffer")}
      </label>
      <Tooltip
        position="bottom"
        content={getI18nOrFallback(
          t,
          "advancedHelp.reasoningTokenBuffer",
          "When enabled, OmniRoute may increase max_tokens for reasoning-capable models. Keep this off unless the combo needs the legacy extra output budget behavior."
        )}
      >
        <span className="material-symbols-outlined text-[12px] text-text-muted cursor-help">
          help
        </span>
      </Tooltip>
    </div>
  );
}
