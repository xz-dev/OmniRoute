import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routeSource = fs.readFileSync("src/app/api/v1/responses/route.ts", "utf8");

test("Responses route wires neutral in_progress frames to startup and recurring keepalives", () => {
  assert.match(
    routeSource,
    /keepaliveFrame:\s*OPENAI_RESPONSES_IN_PROGRESS_FRAME/,
    "recurring ticks must be parsed Responses events, not SSE comments"
  );
  assert.match(
    routeSource,
    /startupFrame:\s*OPENAI_RESPONSES_IN_PROGRESS_FRAME/,
    "the immediate frame must not create a synthetic reasoning item"
  );
  assert.doesNotMatch(routeSource, /RESPONSES_STARTUP_THINKING_FRAME/);
});
