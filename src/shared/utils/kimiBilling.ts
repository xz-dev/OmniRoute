/**
 * kimiBilling.ts — public contract for the Kimi Coding Extra Usage (加油包)
 * billing block shown on Dashboard → Provider Limits quota cards.
 *
 * Source of truth: the official Kimi Code CLI (`MoonshotAI/kimi-code`,
 * packages/oauth/src/managed-usage.ts). The managed `/coding/v1/usages`
 * payload carries a `boosterWallet` object:
 *
 *   "boosterWallet": {
 *     "balance":  { "type": "BOOSTER", "amount": "<fixed-point>", "amountLeft": "<fixed-point>" },
 *     "monthlyChargeLimit": { "priceInCents": 5000, "currency": "CNY" },
 *     "monthlyUsed":        { "priceInCents": 1234, "currency": "CNY" },
 *     "monthlyChargeLimitEnabled": true
 *   }
 *
 * `balance.amount`/`amountLeft` are fixed-point integers at 1_000_000 units
 * per cent; the `monthly*` money wrappers carry integer cents plus the ISO
 * currency. Kimi exposes no auto top-up API, so `autoTopUp` is always
 * `{ available: false }` — only manual top-up exists (via the official
 * subscription page).
 */

export const KIMI_CODE_ADDITIONAL_CREDITS_URL =
  "https://www.kimi.com/membership/subscription?tab=quota&aff=omniroute";

export interface KimiAutoTopUpStatus {
  /** Kimi Code has no auto top-up surface — always false. */
  available: false;
}

export interface KimiBillingStatus {
  /** ISO 4217 currency reported by the wallet's monthly money wrappers. */
  currency: string;
  /** Remaining Extra Usage balance in cents (from `balance.amountLeft`). */
  extraCreditsMinorUnits?: number;
  /** Extra Usage spend so far this calendar month, in cents. */
  monthlyUsedMinorUnits?: number;
  /** Whether the member enabled a monthly spending cap. */
  monthlyLimitEnabled?: boolean;
  /** Monthly spending cap in cents; 0/absent means unlimited. */
  monthlyLimitMinorUnits?: number;
  autoTopUp: KimiAutoTopUpStatus;
  additionalCreditsUrl: typeof KIMI_CODE_ADDITIONAL_CREDITS_URL;
}

export type KimiBillingTranslationKey =
  | "kimiExtraUsageCredits"
  | "kimiMonthlyUsed"
  | "kimiMonthlyLimit"
  | "kimiMonthlyLimitUnlimited"
  | "kimiAutoTopUp"
  | "kimiAutoTopUpUnavailable"
  | "kimiAdditionalCredits";

export type KimiBillingTranslator = (key: KimiBillingTranslationKey, fallback: string) => string;

export type KimiBillingCardRow =
  | { kind: "balance" | "status"; label: string; value: string }
  | {
      kind: "link";
      label: string;
      href: typeof KIMI_CODE_ADDITIONAL_CREDITS_URL;
      target: "_blank";
      rel: "noreferrer noopener";
    };

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function minorUnits(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const ISO_4217 = /^[A-Za-z]{3}$/;

export function sanitizeKimiBillingStatus(value: unknown): KimiBillingStatus | undefined {
  const billing = toRecord(value);
  if (!billing || billing.additionalCreditsUrl !== KIMI_CODE_ADDITIONAL_CREDITS_URL)
    return undefined;

  const rawAutoTopUp = toRecord(billing.autoTopUp);
  // Kimi billing never carries an auto top-up rule — anything claiming
  // availability is not the public contract and must be dropped.
  if (!rawAutoTopUp || rawAutoTopUp.available !== false) return undefined;

  const currency =
    typeof billing.currency === "string" && ISO_4217.test(billing.currency)
      ? billing.currency.toUpperCase()
      : undefined;
  if (!currency) return undefined;

  const extraCreditsMinorUnits = minorUnits(billing.extraCreditsMinorUnits);
  const monthlyUsedMinorUnits = minorUnits(billing.monthlyUsedMinorUnits);
  const monthlyLimitMinorUnits = minorUnits(billing.monthlyLimitMinorUnits);
  const monthlyLimitEnabled =
    typeof billing.monthlyLimitEnabled === "boolean" ? billing.monthlyLimitEnabled : undefined;

  return {
    currency,
    ...(extraCreditsMinorUnits !== undefined ? { extraCreditsMinorUnits } : {}),
    ...(monthlyUsedMinorUnits !== undefined ? { monthlyUsedMinorUnits } : {}),
    ...(monthlyLimitEnabled !== undefined ? { monthlyLimitEnabled } : {}),
    ...(monthlyLimitMinorUnits !== undefined ? { monthlyLimitMinorUnits } : {}),
    autoTopUp: { available: false },
    additionalCreditsUrl: KIMI_CODE_ADDITIONAL_CREDITS_URL,
  };
}

export function formatKimiMinorUnits(
  value: number | undefined,
  currency: KimiBillingStatus["currency"],
  locales?: Intl.LocalesArgument
): string | null {
  if (value === undefined) return null;
  return new Intl.NumberFormat(locales, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

const fallbackTranslation: KimiBillingTranslator = (_key, fallback) => fallback;

export function buildKimiBillingCardRows(
  billing: KimiBillingStatus,
  locales?: Intl.LocalesArgument,
  translate: KimiBillingTranslator = fallbackTranslation
): KimiBillingCardRow[] {
  const rows: KimiBillingCardRow[] = [];
  const walletEnabled = billing.extraCreditsMinorUnits !== undefined;

  const extraCredits = formatKimiMinorUnits(
    billing.extraCreditsMinorUnits,
    billing.currency,
    locales
  );
  if (extraCredits !== null) {
    rows.push({
      kind: "balance",
      label: translate("kimiExtraUsageCredits", "Extra Usage Credits"),
      value: extraCredits,
    });
  }

  // Monthly spend/limit are wallet fields — only render once Extra Usage is
  // enabled, mirroring the official CLI's Extra Usage section.
  if (walletEnabled) {
    const monthlyUsed = formatKimiMinorUnits(
      billing.monthlyUsedMinorUnits,
      billing.currency,
      locales
    );
    if (monthlyUsed !== null) {
      rows.push({
        kind: "status",
        label: translate("kimiMonthlyUsed", "Used this month"),
        value: monthlyUsed,
      });
    }

    const capped =
      billing.monthlyLimitEnabled === true &&
      billing.monthlyLimitMinorUnits !== undefined &&
      billing.monthlyLimitMinorUnits > 0;
    const monthlyLimit = capped
      ? formatKimiMinorUnits(billing.monthlyLimitMinorUnits, billing.currency, locales)
      : null;
    rows.push({
      kind: "status",
      label: translate("kimiMonthlyLimit", "Monthly limit"),
      value: monthlyLimit ?? translate("kimiMonthlyLimitUnlimited", "Unlimited"),
    });
  }

  rows.push({
    kind: "status",
    label: translate("kimiAutoTopUp", "Auto Top-Up"),
    value: translate("kimiAutoTopUpUnavailable", "Unavailable"),
  });
  rows.push({
    kind: "link",
    label: translate("kimiAdditionalCredits", "Additional Credits"),
    href: billing.additionalCreditsUrl,
    target: "_blank",
    rel: "noreferrer noopener",
  });
  return rows;
}
