import test from "node:test";
import assert from "node:assert/strict";

const {
  buildKimiBillingCardRows,
  formatKimiMinorUnits,
  KIMI_CODE_ADDITIONAL_CREDITS_URL,
  sanitizeKimiBillingStatus,
} = await import("../../src/shared/utils/kimiBilling.ts");
type KimiBillingTranslator =
  typeof import("../../src/shared/utils/kimiBilling.ts").KimiBillingTranslator;
const { isKimiBillingStatus, isProviderBillingProvider, sanitizeProviderBillingStatus } =
  await import("../../src/shared/utils/providerBilling.ts");
const { PROVIDER_LABEL } =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/constants.ts");
const { USAGE_SUPPORTED_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

const baseBilling = {
  currency: "CNY",
  autoTopUp: { available: false as const },
  additionalCreditsUrl: KIMI_CODE_ADDITIONAL_CREDITS_URL,
};

test("Kimi billing rows mirror the Grok card when the wallet is unavailable", () => {
  const rows = buildKimiBillingCardRows(baseBilling, "en-US");
  assert.deepEqual(rows, [
    { kind: "status", label: "Auto Top-Up", value: "Unavailable" },
    {
      kind: "link",
      label: "Additional Credits",
      href: KIMI_CODE_ADDITIONAL_CREDITS_URL,
      target: "_blank",
      rel: "noreferrer noopener",
    },
  ]);
});

test("Kimi billing rows show balance, monthly spend, cap, auto-top-up state and buy link", () => {
  const rows = buildKimiBillingCardRows(
    {
      ...baseBilling,
      extraCreditsMinorUnits: 1234,
      monthlyUsedMinorUnits: 250,
      monthlyLimitEnabled: true,
      monthlyLimitMinorUnits: 5000,
    },
    "en-US"
  );

  assert.deepEqual(rows, [
    { kind: "balance", label: "Extra Usage Credits", value: "CN¥12.34" },
    { kind: "status", label: "Used this month", value: "CN¥2.50" },
    { kind: "status", label: "Monthly limit", value: "CN¥50.00" },
    { kind: "status", label: "Auto Top-Up", value: "Unavailable" },
    {
      kind: "link",
      label: "Additional Credits",
      href: KIMI_CODE_ADDITIONAL_CREDITS_URL,
      target: "_blank",
      rel: "noreferrer noopener",
    },
  ]);
});

test("Kimi monthly cap displays Unlimited when disabled or zero", () => {
  for (const billing of [
    { ...baseBilling, extraCreditsMinorUnits: 0, monthlyLimitEnabled: false },
    {
      ...baseBilling,
      extraCreditsMinorUnits: 0,
      monthlyLimitEnabled: true,
      monthlyLimitMinorUnits: 0,
    },
  ]) {
    const row = buildKimiBillingCardRows(billing, "en-US").find(
      (candidate) => candidate.kind === "status" && candidate.label === "Monthly limit"
    );
    assert.deepEqual(row, { kind: "status", label: "Monthly limit", value: "Unlimited" });
  }
});

test("Kimi billing labels support localized translation fallbacks", () => {
  const translate: KimiBillingTranslator = (key, fallback) =>
    ({
      kimiExtraUsageCredits: "加油包余额",
      kimiMonthlyUsed: "本月已用",
      kimiMonthlyLimit: "每月限额",
      kimiMonthlyLimitUnlimited: "无限制",
      kimiAutoTopUp: "自动充值",
      kimiAutoTopUpUnavailable: "不可用",
      kimiAdditionalCredits: "充值加油包",
    })[key] ?? fallback;

  assert.deepEqual(
    buildKimiBillingCardRows(
      { ...baseBilling, extraCreditsMinorUnits: 0, monthlyLimitEnabled: false },
      "zh-CN",
      translate
    ),
    [
      { kind: "balance", label: "加油包余额", value: "¥0.00" },
      { kind: "status", label: "每月限额", value: "无限制" },
      { kind: "status", label: "自动充值", value: "不可用" },
      {
        kind: "link",
        label: "充值加油包",
        href: KIMI_CODE_ADDITIONAL_CREDITS_URL,
        target: "_blank",
        rel: "noreferrer noopener",
      },
    ]
  );
});

test("Kimi billing sanitizer strips private fields and rejects forged public contracts", () => {
  const billing = sanitizeKimiBillingStatus({
    currency: "cny",
    extraCreditsMinorUnits: 0,
    monthlyUsedMinorUnits: 250,
    monthlyLimitEnabled: true,
    monthlyLimitMinorUnits: 5000,
    autoTopUp: { available: false, paymentMethodId: "secret" },
    additionalCreditsUrl: KIMI_CODE_ADDITIONAL_CREDITS_URL,
    rawBody: "secret",
  });

  assert.deepEqual(billing, {
    currency: "CNY",
    extraCreditsMinorUnits: 0,
    monthlyUsedMinorUnits: 250,
    monthlyLimitEnabled: true,
    monthlyLimitMinorUnits: 5000,
    autoTopUp: { available: false },
    additionalCreditsUrl: KIMI_CODE_ADDITIONAL_CREDITS_URL,
  });
  assert.equal(formatKimiMinorUnits(billing?.extraCreditsMinorUnits, "CNY", "zh-CN"), "¥0.00");
  assert.equal(isKimiBillingStatus(billing!), true);
  assert.deepEqual(sanitizeProviderBillingStatus(billing), billing);

  for (const forged of [
    { ...baseBilling, currency: "US<script>" },
    { ...baseBilling, autoTopUp: { available: true } },
    { ...baseBilling, additionalCreditsUrl: "https://attacker.invalid/credits" },
  ]) {
    assert.equal(sanitizeKimiBillingStatus(forged), undefined);
  }
});

test("Provider Limits registers both Kimi Coding billing providers", () => {
  for (const provider of ["kimi-coding", "kimi-coding-apikey"]) {
    assert.equal(isProviderBillingProvider(provider), true);
    assert.ok((USAGE_SUPPORTED_PROVIDERS as readonly string[]).includes(provider));
  }
  assert.equal(PROVIDER_LABEL["kimi-coding"], "Kimi Coding");
});
