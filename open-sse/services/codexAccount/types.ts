import type { CodexQuotaScope } from "../../config/codexQuotaScopes.ts";

/** The persisted Codex connection that owns credentials and provider state. */
export interface CodexAccountConnection {
  readonly id: string;
  readonly provider: string;
  readonly providerSpecificData: Readonly<Record<string, unknown>>;
}

/** Structured identity for a virtual account; it can never be confused with a DB ID. */
export interface CodexAccountKey<TScope extends CodexQuotaScope | null> {
  readonly parentConnectionId: string;
  readonly scope: TScope;
}

interface CodexAccountBase<TScope extends CodexQuotaScope | null> {
  readonly key: CodexAccountKey<TScope>;
  /** The actual persisted connection ID. Children never get a synthetic DB ID. */
  readonly connectionId: string;
  readonly connection: CodexAccountConnection;
}

/** The runtime view of the persisted credential-owning connection. */
export interface CodexParentAccount extends CodexAccountBase<null> {
  readonly kind: "parent";
  readonly scope: null;
}

/** One virtual runtime quota/cooldown child of the persisted connection. */
export interface CodexChildAccount extends CodexAccountBase<CodexQuotaScope> {
  readonly kind: "child";
  readonly scope: CodexQuotaScope;
}

export type CodexAccount = CodexParentAccount | CodexChildAccount;

export interface CodexAccountPool {
  readonly parent: CodexParentAccount;
  readonly children: readonly [CodexChildAccount, CodexChildAccount];
  readonly accounts: readonly [CodexParentAccount, CodexChildAccount, CodexChildAccount];
}

export type CodexAccountPoolStatus = "available" | "partially_limited" | "fully_limited";

export interface CodexAccountPoolState {
  readonly kind: "parent";
  readonly status: CodexAccountPoolStatus;
  readonly limitedScopes: readonly CodexQuotaScope[];
}

export interface CodexChildAccountState {
  readonly kind: "child";
  readonly scope: CodexQuotaScope;
  readonly unavailable: boolean;
  readonly rateLimitedUntil: string | null;
}

export type CodexAccountState = CodexAccountPoolState | CodexChildAccountState;

export interface CodexChildCooldown {
  readonly account: CodexChildAccount;
  readonly until: string;
}
