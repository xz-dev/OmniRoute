"use client";

import { useTranslations } from "next-intl";
import Card from "@/shared/components/Card";
import type { ComboControlCenterCombo } from "@/lib/combos/controlCenter";

type Diagnostics = NonNullable<ComboControlCenterCombo["context_diagnostics"]>;

function tokens(value: number | undefined, unknown: string) {
  return typeof value === "number" ? value.toLocaleString() : unknown;
}

export function ComboContextDiagnosticsCard({ diagnostics }: { diagnostics: Diagnostics }) {
  const t = useTranslations("comboControl");
  const unknown = t("unknown");
  const reason = (value?: string) =>
    value ? t(`contextDiagnostics.unknownReason.${value}` as never) : unknown;
  return (
    <Card className="p-5" data-testid="combo-context-diagnostics">
      <h2 className="text-lg font-semibold text-text-main">{t("contextDiagnostics.title")}</h2>
      <p className="mt-1 text-sm text-text-muted">
        {t("contextDiagnostics.summary", {
          mode: t(`contextDiagnostics.mode.${diagnostics.mode}`),
          source: t(`contextDiagnostics.sources.${diagnostics.source}`),
          effective: tokens(diagnostics.effective_context_length, unknown),
          count: diagnostics.known_count,
          min: tokens(diagnostics.known_min, unknown),
          max: tokens(diagnostics.known_max, unknown),
        })}
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-text-muted">
            <tr>
              <th scope="col" className="pb-2">
                {t("contextDiagnostics.providerModel")}
              </th>
              <th scope="col">{t("contextDiagnostics.context")}</th>
              <th scope="col">{t("contextDiagnostics.input")}</th>
              <th scope="col">{t("contextDiagnostics.output")}</th>
              <th scope="col">{t("contextDiagnostics.sourceHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {diagnostics.targets.length === 0 ? (
              <tr data-testid="combo-context-empty-targets">
                <td colSpan={5} className="border-t border-border py-3 text-text-muted">
                  {t("contextDiagnostics.noTargets")}
                </td>
              </tr>
            ) : (
              diagnostics.targets.map((target, index) => (
                <tr
                  key={`${target.provider}/${target.model}-${index}`}
                  className="border-t border-border"
                >
                  <td className="py-2 font-mono">
                    {target.provider}/{target.model}
                  </td>
                  <td>{tokens(target.context_length, unknown)}</td>
                  <td>{tokens(target.max_input_tokens, unknown)}</td>
                  <td>{tokens(target.max_output_tokens, unknown)}</td>
                  <td>
                    {target.unknown_reason
                      ? reason(target.unknown_reason)
                      : [target.context_source, target.input_source, target.output_source]
                          .map((source) => source || unknown)
                          .join(" · ")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
