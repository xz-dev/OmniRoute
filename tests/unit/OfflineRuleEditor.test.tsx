// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfflineRuleEditor from "@/app/(dashboard)/dashboard/combos/OfflineRuleEditor";
import { DEFAULT_OFFLINE_CONDITION } from "@/lib/combos/offlineRuleDraft";

const labels = {
  enabled: "Hard offline rule",
  condition: "Safe JSON Logic (advanced/custom condition)",
  cooldown: "Cooldown",
  help: "Help",
};

let container: HTMLDivElement;
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

function editor(comboId: string, step: Record<string, unknown>, onErrorChange = vi.fn()) {
  return (
    <OfflineRuleEditor
      key={`${comboId}:${String(step.id)}`}
      step={step}
      labels={labels}
      onChange={vi.fn()}
      onErrorChange={onErrorChange}
    />
  );
}

function StatefulEditor() {
  const [step, setStep] = useState<Record<string, unknown>>({
    id: "disabled-step",
    model: "codex/gpt",
  });
  return (
    <OfflineRuleEditor step={step} labels={labels} onChange={setStep} onErrorChange={vi.fn()} />
  );
}

describe("OfflineRuleEditor", () => {
  it("remounts for a different Combo session with the same step identity", async () => {
    await act(async () => {
      root.render(
        editor("combo-a", {
          id: "shared-step",
          offlineCondition: DEFAULT_OFFLINE_CONDITION,
          offlineCooldownMs: 1_000,
        })
      );
    });
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe(
      "1000"
    );

    await act(async () => {
      root.render(
        editor("combo-b", {
          id: "shared-step",
          offlineCondition: { "==": [{ var: "response.status" }, 429] },
          offlineCooldownMs: 2_000,
        })
      );
    });
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe(
      "2000"
    );
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toContain("429");
  });

  it("hides advanced/custom JSON until Hard Offline is enabled", async () => {
    await act(async () => {
      root.render(<StatefulEditor />);
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('input[type="number"]')).toBeNull();

    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const cooldown = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(textarea).not.toBeNull();
    expect(cooldown.value).toBe("300000");
    expect(container.querySelector(`label[for="${textarea.id}"]`)?.textContent).toBe(
      "Safe JSON Logic (advanced/custom condition)"
    );
    expect(container.querySelector(`label[for="${cooldown.id}"]`)?.textContent).toBe("Cooldown");
  });
});
