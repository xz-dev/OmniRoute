import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("token health-check scheduler initializes in a production process", () => {
  const env = { ...process.env };
  env.NODE_ENV = "production";
  env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "true";
  delete env.NEXT_PHASE;
  delete env.OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK;
  delete env.VITEST;

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "--eval",
      'const scheduler = await import("./src/lib/tokenHealthCheck.ts"); scheduler.initTokenHealthCheck(); scheduler.stopTokenHealthCheck();',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 15_000,
    }
  );

  assert.equal(
    result.status,
    0,
    [result.stderr, result.stdout].filter(Boolean).join("\n") || "scheduler process failed"
  );
});
