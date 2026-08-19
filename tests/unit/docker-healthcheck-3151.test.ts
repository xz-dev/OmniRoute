import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

// #3151 — Docker healthcheck always reports unhealthy because the probe only
// hit 127.0.0.1 and swallowed every error (empty Output, undiagnosable).
// The hardened script exports an injectable `probeHealth` helper that tries an
// ordered host list and surfaces the last error on total failure.
const { probeHealth } = (await import("../../scripts/dev/healthcheck.mjs")) as {
  probeHealth: (opts: {
    port: number | string;
    hosts?: string[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) => Promise<string>;
};

/** Start an ephemeral HTTP server bound only to the given host. */
function startServer(host: string, status = 200): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: status === 200 ? "ok" : "error" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("no address"));
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const servers: http.Server[] = [];

test.after(async () => {
  for (const s of servers) {
    await closeServer(s);
  }
});

test("probeHealth resolves the host when the server is on 127.0.0.1", async () => {
  const { server, port } = await startServer("127.0.0.1");
  servers.push(server);

  const ok = await probeHealth({ port, hosts: ["127.0.0.1", "localhost", "::1"] });
  assert.equal(ok, "127.0.0.1");
});

test("probeHealth falls through to a later host when 127.0.0.1 is unreachable", async () => {
  // Bind the real server on 127.0.0.1, but list an unreachable host first so
  // the helper must fall through. We point the first host at a port with no
  // listener to simulate ECONNREFUSED, then the real host on the same port.
  const { server, port } = await startServer("127.0.0.1");
  servers.push(server);

  // First host resolves to nothing listening (use a host alias that will fail),
  // second host is the working loopback.
  const ok = await probeHealth({
    port,
    hosts: ["192.0.2.1", "127.0.0.1"], // 192.0.2.1 = TEST-NET-1, unroutable
    timeoutMs: 300,
  });
  assert.equal(ok, "127.0.0.1");
});

test("probeHealth rejects when the packaged endpoint returns HTTP 503", async () => {
  const { server, port } = await startServer("127.0.0.1", 503);
  servers.push(server);

  await assert.rejects(() => probeHealth({ port, hosts: ["127.0.0.1"] }), /127\.0\.0\.1: HTTP 503/);
});

test("image and Compose healthchecks require four failed 30-second probes", () => {
  const dockerfile = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const compose = fs.readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const prodCompose = fs.readFileSync(
    new URL("../../docker-compose.prod.yml", import.meta.url),
    "utf8"
  );

  assert.ok(
    dockerfile.includes("HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=4"),
    "Dockerfile image healthcheck must wait for four 30-second failures"
  );
  const composeContract =
    /test: \["CMD", "node", "healthcheck\.mjs"\]\s+interval: 30s\s+timeout: 5s\s+retries: 4/;
  assert.match(compose, composeContract, "Compose app healthcheck contract drifted");
  assert.match(prodCompose, composeContract, "Production Compose healthcheck contract drifted");
});

test("probeHealth throws a non-empty error string when every host fails", async () => {
  // No server started: pick a port unlikely to have a listener.
  await assert.rejects(
    () =>
      probeHealth({
        port: 1, // privileged/closed port → connection refused
        hosts: ["127.0.0.1", "localhost"],
        timeoutMs: 300,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0, "error message must be non-empty (not swallowed)");
      return true;
    }
  );
});
