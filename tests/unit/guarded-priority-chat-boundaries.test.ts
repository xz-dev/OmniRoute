import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldReturnSelectedResponseToGuardedExecutor,
  shouldUseGlobalFallbackForCombo,
} from "../../src/sse/handlers/chatBoundary.ts";

const FALLBACK = "paid/fallback";

test("Guarded Priority returns account A's transient failure to its executor without account B", () => {
  assert.equal(
    shouldReturnSelectedResponseToGuardedExecutor("guarded-priority", false),
    true,
    "the selected-account response must return before internal account fallback"
  );
  assert.equal(
    shouldReturnSelectedResponseToGuardedExecutor("priority", false),
    false,
    "ordinary Priority keeps existing internal account fallback behavior"
  );
});

test("Guarded Priority never invokes the global fallback for 502 or pre-dispatch 503", () => {
  assert.equal(
    shouldUseGlobalFallbackForCombo(
      "guarded-priority",
      new Response("upstream", { status: 502 }),
      FALLBACK
    ),
    false
  );
  assert.equal(
    shouldUseGlobalFallbackForCombo(
      "guarded-priority",
      new Response("unavailable", { status: 503 }),
      FALLBACK
    ),
    false
  );
  assert.equal(
    shouldUseGlobalFallbackForCombo(
      "priority",
      new Response("upstream", { status: 502 }),
      FALLBACK
    ),
    true,
    "ordinary Priority retains global fallback behavior"
  );
});

test("Guarded Priority only permits configured advancement after the executor evaluates a matching response", () => {
  const accountAResponse = new Response("quota exhausted", { status: 429 });
  assert.equal(
    shouldReturnSelectedResponseToGuardedExecutor("guarded-priority", accountAResponse.ok),
    true,
    "the executor receives account A's authoritative response and alone evaluates Hard Offline"
  );
});
