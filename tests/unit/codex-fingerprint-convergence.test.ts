import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCodexClientIdentityHeaders,
  applyCodexClientMetadata,
  createCodexClientIdentity,
  getCodexClientSessionId,
  getCodexConvergedSessionId,
  getCodexConvergedThreadId,
  getCodexFingerprintMode,
  getCodexInstallationId,
  resolveCodexFingerprintIdentity,
} from "../../open-sse/config/codexIdentity.ts";

const oauthCredentials = {
  accessToken: "oauth-token",
  connectionId: "connection-42",
  providerSpecificData: { workspaceId: "workspace-42" },
};

test("Codex fingerprint mode defaults to session and only explicit off disables it", () => {
  assert.equal(getCodexFingerprintMode(undefined), "session");
  assert.equal(getCodexFingerprintMode({ codexFingerprintMode: "invalid" }), "session");
  assert.equal(getCodexFingerprintMode({ codexFingerprintMode: "off" }), "off");
  assert.equal(
    resolveCodexFingerprintIdentity({
      credentials: { ...oauthCredentials, providerSpecificData: { codexFingerprintMode: "off" } },
      clientHeaders: { "session-id": "client-session" },
      body: {},
    }),
    null
  );
});

test("Codex device/session/full modes preserve their Sub2API convergence boundaries", () => {
  const providerSpecificData = { workspaceId: "workspace-42" };
  const device = createCodexClientIdentity("client-session-a", providerSpecificData, {
    mode: "device",
  });
  const sessionA = createCodexClientIdentity("client-session-a", providerSpecificData, {
    mode: "session",
    accountKey: "connection-42",
  });
  const sessionB = createCodexClientIdentity("client-session-b", providerSpecificData, {
    mode: "session",
    accountKey: "connection-42",
  });
  const fullA = createCodexClientIdentity("client-session-a", providerSpecificData, {
    mode: "full",
    accountKey: "connection-42",
  });
  const fullB = createCodexClientIdentity("client-session-b", providerSpecificData, {
    mode: "full",
    accountKey: "connection-42",
  });

  assert.ok(device && sessionA && sessionB && fullA && fullB);
  assert.equal(device.installationId, getCodexInstallationId(providerSpecificData, undefined));
  assert.notEqual(
    getCodexInstallationId({}, "connection-a"),
    getCodexInstallationId({}, "connection-b")
  );
  assert.equal(device.sessionId, "");
  assert.equal(sessionA.sessionId, sessionB.sessionId);
  assert.notEqual(sessionA.threadId, sessionB.threadId);
  assert.equal(sessionA.windowId, `${sessionA.threadId}:0`);
  assert.equal(fullA.sessionId, fullB.sessionId);
  assert.equal(fullA.threadId, fullA.sessionId);
  assert.equal(fullA.threadId, fullB.threadId);
  assert.notEqual(sessionA.turnId, sessionB.turnId);
  assert.equal(
    getCodexConvergedSessionId(providerSpecificData, "connection-42"),
    sessionA.sessionId
  );
  assert.equal(
    getCodexConvergedThreadId("client-session-a", providerSpecificData, "connection-42"),
    sessionA.threadId
  );
});

test("Codex client session extraction prefers hyphenated session-id and rejects unsafe values", () => {
  assert.equal(
    getCodexClientSessionId({ "session-id": "hyphen", session_id: "underscore" }),
    "hyphen"
  );
  assert.equal(getCodexClientSessionId({ session_id: "underscore" }), "underscore");
  assert.equal(getCodexClientSessionId({ "session-id": "bad\\r\\nheader" }), null);
});

test("One Codex identity is shared by headers, body metadata, and nested turn metadata", () => {
  const identity = resolveCodexFingerprintIdentity({
    credentials: oauthCredentials,
    clientHeaders: { "session-id": "client-session" },
    body: {},
  });
  assert.ok(identity);

  const headers: Record<string, string> = {};
  applyCodexClientIdentityHeaders(headers, identity);
  const body: Record<string, unknown> = {
    client_metadata: { "x-codex-turn-metadata": '{"sandbox":"none"}' },
  };
  applyCodexClientMetadata(body, identity);

  const headerMetadata = JSON.parse(headers["x-codex-turn-metadata"]);
  const clientMetadata = body.client_metadata as Record<string, unknown>;
  const bodyMetadata = JSON.parse(clientMetadata["x-codex-turn-metadata"] as string);

  assert.equal(headers["session-id"], clientMetadata.session_id);
  assert.equal(headers["thread-id"], clientMetadata.thread_id);
  assert.equal(headers["x-codex-window-id"], clientMetadata["x-codex-window-id"]);
  assert.equal(identity.installationId, headers["x-codex-installation-id"]);
  assert.equal(identity.turnId, clientMetadata.turn_id);
  assert.equal(identity.turnId, headerMetadata.turn_id);
  assert.equal(identity.turnId, bodyMetadata.turn_id);
  assert.equal(bodyMetadata.sandbox, "none");
});

test("Codex compact requests do not resolve a fingerprint identity", () => {
  assert.equal(
    resolveCodexFingerprintIdentity({
      credentials: {
        ...oauthCredentials,
        requestEndpointPath: "/responses/compact",
      },
      clientHeaders: { "session-id": "client-session" },
      body: {},
    }),
    null
  );
});

test("Codex websocket headers and payload share one fingerprint identity", async () => {
  const { CodexExecutor, __setCodexWebSocketTransportForTesting } =
    await import("../../open-sse/executors/codex.ts");
  const executor = new CodexExecutor();
  let sent: string | null = null;
  let wsHeaders: Record<string, string> = {};
  __setCodexWebSocketTransportForTesting(async (_url, opts) => {
    wsHeaders = (opts?.headers as Record<string, string>) || {};
    return {
      send(data: string) {
        sent = data;
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "response.completed",
              response: { status: "completed" },
            }),
          });
        });
      },
      close() {},
      onmessage: null,
      onerror: null,
      onclose: null,
    };
  });

  try {
    const result = await executor.execute({
      model: "gpt-5.5",
      body: {
        model: "gpt-5.5",
        session_id: "client-ws",
        input: [{ role: "user", content: "hello" }],
      },
      stream: true,
      credentials: {
        accessToken: "codex-token",
        connectionId: "conn-ws",
        providerSpecificData: { workspaceId: "ws-ws", codexTransport: "websocket" },
      },
    });
    await result.response.text();
  } finally {
    __setCodexWebSocketTransportForTesting(undefined);
  }

  assert.ok(sent);
  const payload = JSON.parse(sent as string) as Record<string, unknown>;
  const metadata = (payload.client_metadata as Record<string, unknown>) || {};
  assert.equal(wsHeaders.session_id, metadata.session_id);
  assert.equal(wsHeaders["x-client-request-id"], metadata.thread_id);
  assert.equal(wsHeaders["x-codex-window-id"], metadata["x-codex-window-id"]);
  assert.equal(payload.type, "response.create");
});
