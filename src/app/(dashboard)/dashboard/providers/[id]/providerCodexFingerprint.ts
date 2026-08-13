import { providerText, type ProviderMessageTranslator } from "./providerCredentialText";

export const CODEX_FINGERPRINT_MODE_VALUES = ["off", "device", "session", "full"] as const;
export type CodexFingerprintModeValue = (typeof CODEX_FINGERPRINT_MODE_VALUES)[number];

export function getCodexFingerprintMode(providerSpecificData: unknown): CodexFingerprintModeValue {
  const data =
    providerSpecificData &&
    typeof providerSpecificData === "object" &&
    !Array.isArray(providerSpecificData)
      ? (providerSpecificData as Record<string, unknown>)
      : undefined;
  const raw = data?.codexFingerprintMode ?? data?.codex_fingerprint_mode;
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (CODEX_FINGERPRINT_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as CodexFingerprintModeValue)
    : "session";
}

export function getCodexFingerprintModeLabel(
  t: ProviderMessageTranslator,
  value: CodexFingerprintModeValue
): string {
  if (value === "off") {
    return providerText(t, "codexFingerprintModeOff", "Off — pass client IDs through");
  }
  if (value === "device") {
    return providerText(t, "codexFingerprintModeDevice", "Device — one installation ID");
  }
  if (value === "full") {
    return providerText(t, "codexFingerprintModeFull", "Full — one device, session, and thread");
  }
  return providerText(
    t,
    "codexFingerprintModeSession",
    "Session — one device and session, thread per client"
  );
}
