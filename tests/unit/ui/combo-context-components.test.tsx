// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTranslator } from "use-intl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../src/i18n/messages/en.json";

const translators = {
  combos: createTranslator({
    locale: "en",
    messages: en.combos,
    onError: (error) => {
      throw error;
    },
  }),
  comboControl: createTranslator({
    locale: "en",
    messages: en.comboControl,
    onError: (error) => {
      throw error;
    },
  }),
};

vi.mock("next-intl", () => ({
  useTranslations: (namespace: keyof typeof translators) => translators[namespace],
}));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ComboContextAggregationField", () => {
  it("defaults to minimum and emits maximum through the save callback seam", async () => {
    const { ComboContextAggregationField } =
      await import("@/app/(dashboard)/dashboard/combos/ComboContextAggregationField");
    const onChange = vi.fn();
    await act(async () => {
      root.render(<ComboContextAggregationField onChange={onChange} />);
    });

    const select = container.querySelector('[data-testid="combo-context-aggregation"]');
    expect(select).toHaveProperty("value", "min");
    await act(async () => {
      const element = select as HTMLSelectElement;
      element.value = "max";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("renders manual wording and accessible maximum warning", async () => {
    const { ComboContextAggregationField } =
      await import("@/app/(dashboard)/dashboard/combos/ComboContextAggregationField");
    await act(async () => {
      root.render(<ComboContextAggregationField value="max" onChange={() => {}} />);
    });

    expect(container.textContent).toContain("Manual context length");
    expect(container.textContent).toContain("Manual value overrides target aggregation.");
    const warning = container.querySelector('[data-testid="combo-context-max-warning"]');
    expect(warning?.textContent).toContain("Maximum may exceed smaller targets");
    expect(warning?.className).toContain("text-amber-700");
    expect(container.querySelector('label[for="combo-context-aggregation"]')).not.toBeNull();
  });
});

describe("ComboContextDiagnosticsCard", () => {
  it.each([
    ["manual", "Manual"],
    ["aggregated", "Aggregated"],
    ["unknown", "Unknown"],
  ] as const)("renders %s source from production messages", async (source, label) => {
    const { ComboContextDiagnosticsCard } =
      await import("@/app/(dashboard)/dashboard/combos/ComboContextDiagnosticsCard");
    await act(async () => {
      root.render(
        <ComboContextDiagnosticsCard
          diagnostics={{
            mode: "max",
            source,
            effective_context_length: 1_050_000,
            known_min: 272_000,
            known_max: 1_050_000,
            known_count: 2,
            targets: [
              {
                provider: "codex",
                model: "gpt-5.6-sol",
                context_length: 1_050_000,
                max_input_tokens: 250_000,
                max_output_tokens: 80_000,
                context_source: "manual",
                input_source: "capability-override",
                output_source: "synced",
              },
            ],
          }}
        />
      );
    });

    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("1,050,000");
    expect(container.textContent).toContain("250,000");
    expect(container.textContent).toContain("80,000");
    expect(container.textContent).toContain("manual · capability-override · synced");
    expect(Array.from(container.querySelectorAll('th[scope="col"]')).at(-1)?.textContent).toBe(
      "Source"
    );
  });

  it("translates unknown reasons and renders empty targets", async () => {
    const { ComboContextDiagnosticsCard } =
      await import("@/app/(dashboard)/dashboard/combos/ComboContextDiagnosticsCard");
    const base = {
      mode: "min" as const,
      source: "unknown" as const,
      known_count: 0,
    };
    await act(async () => {
      root.render(
        <ComboContextDiagnosticsCard
          diagnostics={{
            ...base,
            targets: [
              { provider: "unknown", model: "mystery", unknown_reason: "target-unresolved" },
            ],
          }}
        />
      );
    });
    expect(container.textContent).toContain("Target unresolved");

    await act(async () => {
      root.render(<ComboContextDiagnosticsCard diagnostics={{ ...base, targets: [] }} />);
    });
    expect(container.textContent).toContain("No resolved targets.");
    expect(container.querySelector('[data-testid="combo-context-empty-targets"]')).not.toBeNull();
  });
});
