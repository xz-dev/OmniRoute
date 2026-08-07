import type { ComboLike } from "./types.ts";

const MAX_RULE_DEPTH = 12;
const MAX_RULE_NODES = 64;
const MAX_TEXT_LENGTH = 4000;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 512;

const ALLOWED_VARS = new Set([
  "response.status",
  "response.statusText",
  "response.text",
  "response.headers",
  "error.code",
  "error.type",
  "error.message",
]);
const ALLOWED_OPERATORS = new Set([
  "and",
  "or",
  "!",
  "==",
  "!=",
  "in",
  "cat",
  "omniroute.accountUnavailable",
]);

export type OfflineRuleFacts = {
  response: {
    status: number;
    statusText: string;
    text: string;
    headers: Record<string, string>;
  };
  error: { code: string; type: string; message: string };
};

export type OfflineRuleConfig = {
  offlineCondition?: unknown;
  offlineCooldownMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonLogicError(message: string): Error {
  return new Error(`Invalid offlineCondition: ${message}`);
}

function countNode(depth: number, state: { nodes: number }): void {
  if (++state.nodes > MAX_RULE_NODES) throw jsonLogicError("too many nodes");
  if (depth > MAX_RULE_DEPTH) throw jsonLogicError("maximum depth exceeded");
}

function validateRule(value: unknown, depth: number, state: { nodes: number }): void {
  countNode(depth, state);
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH) throw jsonLogicError("string value is too long");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateRule(item, depth + 1, state);
    return;
  }
  if (!isRecord(value)) throw jsonLogicError("rule must use JSON values");
  const entries = Object.entries(value);
  if (entries.length !== 1) throw jsonLogicError("each expression must have one operator");
  const [operator, args] = entries[0];
  if (!ALLOWED_OPERATORS.has(operator)) throw jsonLogicError(`operator ${operator} is not allowed`);
  const values = Array.isArray(args)
    ? args
    : operator === "!"
      ? [args]
      : operator === "omniroute.accountUnavailable" && args === null
        ? []
        : null;
  if (!values) throw jsonLogicError(`${operator} requires an array of arguments`);
  countNode(depth + 1, state);
  for (const arg of values) {
    if (
      isRecord(arg) &&
      Object.keys(arg).length === 1 &&
      Object.prototype.hasOwnProperty.call(arg, "var")
    ) {
      countNode(depth + 2, state);
      const path = arg.var;
      if (typeof path !== "string" || !ALLOWED_VARS.has(path))
        throw jsonLogicError("variable path is not allowed");
    } else {
      validateRule(arg, depth + 2, state);
    }
  }
}

export function validateOfflineCondition(value: unknown): void {
  if (value === undefined) return;
  validateRule(value, 0, { nodes: 0 });
}

function variable(path: string, facts: OfflineRuleFacts): unknown {
  if (!ALLOWED_VARS.has(path)) return undefined;
  const [root, key] = path.split(".");
  if (root === "response") return facts.response[key as keyof OfflineRuleFacts["response"]];
  return facts.error[key as keyof OfflineRuleFacts["error"]];
}

function evaluate(value: unknown, facts: OfflineRuleFacts): unknown {
  if (Array.isArray(value)) return value.map((item) => evaluate(item, facts));
  if (!isRecord(value)) return value;
  const [operator, rawArgs] = Object.entries(value)[0] || [];
  const args = (Array.isArray(rawArgs) ? rawArgs : [rawArgs]).map((arg) =>
    isRecord(arg) &&
    Object.keys(arg).length === 1 &&
    Object.prototype.hasOwnProperty.call(arg, "var")
      ? variable(String(arg.var), facts)
      : evaluate(arg, facts)
  );
  switch (operator) {
    case "and":
      return args.every(Boolean);
    case "or":
      return args.some(Boolean);
    case "!":
      return !args[0];
    case "==":
      return args.length >= 2 && args[0] === args[1];
    case "!=":
      return args.length >= 2 && args[0] !== args[1];
    case "in":
      return typeof args[1] === "string"
        ? args[1].includes(String(args[0]))
        : Array.isArray(args[1]) && args[1].includes(args[0]);
    case "cat":
      return args.map((arg) => String(arg ?? "")).join("");
    case "omniroute.accountUnavailable": {
      if (facts.response.status === 503) return true;
      const signal =
        `${facts.error.code} ${facts.error.type} ${facts.error.message} ${facts.response.text}`.toLowerCase();
      return /(?:insufficient[_ -]?quota|quota[_ -]?(?:exhausted|depleted)|credits?[_ -]?(?:exhausted|depleted)|usage limit reached|billing[_ -]?hard[_ -]?limit|account (?:deactivated|disabled|suspended)|subscription (?:expired|inactive))/.test(
        signal
      );
    }
    default:
      return false;
  }
}

export function matchesOfflineCondition(condition: unknown, facts: OfflineRuleFacts): boolean {
  if (condition === undefined) return false;
  validateOfflineCondition(condition);
  return Boolean(evaluate(condition, facts));
}

export function buildOfflineRuleFacts(response: Response): Promise<OfflineRuleFacts> {
  return (async () => {
    let text = "";
    try {
      text = (await response.clone().text()).slice(0, MAX_TEXT_LENGTH);
    } catch {
      /* unavailable */
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }
    const rawError = isRecord(parsed?.error) ? parsed.error : {};
    const headers: Record<string, string> = {};
    let count = 0;
    response.headers.forEach((value, key) => {
      if (count++ < MAX_HEADER_COUNT)
        headers[key.toLowerCase()] = value.slice(0, MAX_HEADER_VALUE_LENGTH);
    });
    return {
      response: {
        status: response.status,
        statusText: response.statusText.slice(0, 128),
        text,
        headers,
      },
      error: {
        code: typeof rawError.code === "string" ? rawError.code.slice(0, 128) : "",
        type: typeof rawError.type === "string" ? rawError.type.slice(0, 128) : "",
        message:
          typeof rawError.message === "string"
            ? rawError.message.slice(0, 1000)
            : typeof parsed?.message === "string"
              ? parsed.message.slice(0, 1000)
              : "",
      },
    };
  })();
}

export function hardOfflineRuleEnabled(combo: ComboLike): boolean {
  return (
    combo.strategy === "guarded-priority" &&
    Array.isArray(combo.models) &&
    combo.models.some((step) => isRecord(step) && step.offlineCondition !== undefined)
  );
}

export function getOfflineRuleConfig(step: unknown): OfflineRuleConfig {
  if (!isRecord(step)) return {};
  return {
    offlineCondition: step.offlineCondition,
    offlineCooldownMs:
      typeof step.offlineCooldownMs === "number" ? step.offlineCooldownMs : undefined,
  };
}
