import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER_QUOTA_WIDGET_PATH = join(ROOT, "src/app/(dashboard)/home/ProviderQuotaWidget.tsx");

const providerQuotaWidgetSrc = readFileSync(PROVIDER_QUOTA_WIDGET_PATH, "utf8");

test("ProviderQuotaWidget passes provider IDs using ProviderIcon's providerId prop", () => {
  assert.match(
    providerQuotaWidgetSrc,
    /<ProviderIcon\s+providerId=\{provider\}\s+size=\{18\}\s*\/>/,
    "ProviderQuotaWidget must pass provider through ProviderIcon's providerId prop"
  );
  assert.doesNotMatch(
    providerQuotaWidgetSrc,
    /<ProviderIcon\s+provider=\{provider\}/,
    "ProviderQuotaWidget must not pass an unsupported provider prop to ProviderIcon"
  );
});
