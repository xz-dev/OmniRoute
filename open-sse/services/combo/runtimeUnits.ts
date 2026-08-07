// Nested combo runtime unit execution — see combo.ts for integration.
import { errorResponse } from "../../utils/error.ts";
import { markConnectionRateLimitedUntil } from "../../../src/lib/db/providers/rateLimit.ts";
import { recordComboRequest } from "../comboMetrics.ts";
import { resolveDelayMs } from "./comboPredicates.ts";
import { buildOfflineRuleFacts, matchesOfflineCondition } from "./offlineRule.ts";
import { isNodeOffline, recordNodeOffline } from "./offlineState.ts";
import { validateResponseQuality, releaseQualityClone } from "./validateQuality.ts";
import type { ResponseValidationConfig } from "./responseValidation.ts";
import type {
  ComboCollectionLike,
  ComboLike,
  ComboLogger,
  ComboNestingContext,
  HandleComboChatOptions,
  HandleSingleModel,
  IsModelAvailable,
  ResolvedComboRefTarget,
  ResolvedComboUnit,
} from "./types.ts";

export type RuntimeUnitExecutionResult = {
  response: Response;
  unit: ResolvedComboUnit | null;
};

// Reserved headers may still appear on responses for defense-in-depth stripping,
// but they are NEVER treated as authoritative. Local pre-dispatch provenance is
// carried only via object-identity metadata keyed by the exact Response instance.
const GUARDED_PREDISPATCH_UNAVAILABLE_HEADER = "x-omniroute-guarded-predispatch-unavailable";
const GUARDED_QUOTA_EXHAUSTED_HEADER = "x-omniroute-guarded-quota-exhausted";
const GUARDED_QUOTA_EXHAUSTED_IDS_HEADER = "x-omniroute-guarded-quota-exhausted-ids";

type TrustedPredispatchMetadata =
  | { kind: "generic-unavailable" }
  | {
      kind: "quota-exhausted";
      quotaExhaustedConnectionIds: string[];
      selectedConnectionId: string | null;
    };

const trustedPredispatchByResponse = new WeakMap<Response, TrustedPredispatchMetadata>();

type RuntimeUnitRunner = (options: HandleComboChatOptions) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getCombosList(allCombos: ComboCollectionLike): ComboLike[] {
  const combos = Array.isArray(allCombos) ? allCombos : allCombos?.combos || [];
  return combos.filter(
    (combo): combo is ComboLike => isRecord(combo) && typeof combo.name === "string"
  );
}

function findComboByName(allCombos: ComboCollectionLike, name: string): ComboLike | null {
  return getCombosList(allCombos).find((combo) => combo.name === name) || null;
}

function unitDisplayName(unit: ResolvedComboUnit): string {
  return unit.kind === "combo-ref" ? `combo:${unit.comboName}` : unit.modelStr;
}

function rememberTrustedPredispatch(
  response: Response,
  metadata: TrustedPredispatchMetadata
): Response {
  trustedPredispatchByResponse.set(response, metadata);
  return response;
}

function getTrustedPredispatch(response: Response): TrustedPredispatchMetadata | null {
  return trustedPredispatchByResponse.get(response) ?? null;
}

function stripInternalGuardedHeaders(response: Response): Response {
  const trusted = getTrustedPredispatch(response);
  const headers = new Headers(response.headers);
  headers.delete("x-omniroute-selected-connection-id");
  headers.delete(GUARDED_PREDISPATCH_UNAVAILABLE_HEADER);
  headers.delete(GUARDED_QUOTA_EXHAUSTED_HEADER);
  headers.delete(GUARDED_QUOTA_EXHAUSTED_IDS_HEADER);
  const stripped = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  // Cloning for outbound strip must preserve trusted object-identity metadata.
  if (trusted) rememberTrustedPredispatch(stripped, trusted);
  return stripped;
}

function selectedConnectionId(response: Response): string | null {
  const trusted = getTrustedPredispatch(response);
  if (trusted?.kind === "quota-exhausted" && trusted.selectedConnectionId) {
    return trusted.selectedConnectionId;
  }
  // Upstream path: chat boundary overwrites this header with the real selected
  // credentials.connectionId after dispatch. Ordinary upstream forgeries are
  // replaced before the Guarded executor reads the value.
  const value = response.headers.get("x-omniroute-selected-connection-id");
  return value && value.trim().length > 0 ? value.trim() : null;
}

function trustedQuotaExhaustedConnectionIds(response: Response): string[] {
  const trusted = getTrustedPredispatch(response);
  if (trusted?.kind !== "quota-exhausted") return [];
  return trusted.quotaExhaustedConnectionIds.filter((id) => id.trim().length > 0);
}

function shuffleUnits(units: ResolvedComboUnit[]): ResolvedComboUnit[] {
  const result = [...units];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function selectWeightedUnit(units: ResolvedComboUnit[]): ResolvedComboUnit | null {
  const total = units.reduce((sum, unit) => sum + Math.max(0, Number(unit.weight) || 0), 0);
  if (total <= 0) return units[0] || null;
  let draw = Math.random() * total;
  for (const unit of units) {
    draw -= Math.max(0, Number(unit.weight) || 0);
    if (draw <= 0) return unit;
  }
  return units[units.length - 1] || null;
}

async function executeModelUnit(args: {
  body: Record<string, unknown>;
  unit: Extract<ResolvedComboUnit, { kind: "model" }>;
  handleSingleModel: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  failoverBeforeRetry: unknown;
  effectiveComboStrategy: string;
}): Promise<Response> {
  if (args.isModelAvailable) {
    const availability = await args.isModelAvailable(args.unit.modelStr, args.unit);
    if (availability !== true) {
      const response = errorResponse(503, `Model ${args.unit.modelStr} is unavailable`);
      // Authoritative local quota-policy exhaustion is recorded only via the
      // Response object identity. Headers are intentionally NOT used as authority
      // (upstream can forge them). Generic pre-dispatch unavailability stays no-fallback.
      if (
        availability &&
        typeof availability === "object" &&
        availability.reason === "quota-exhausted" &&
        Array.isArray(availability.quotaExhaustedConnectionIds) &&
        availability.quotaExhaustedConnectionIds.length > 0
      ) {
        const exhaustedIds = availability.quotaExhaustedConnectionIds
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0);
        return rememberTrustedPredispatch(response, {
          kind: "quota-exhausted",
          quotaExhaustedConnectionIds: exhaustedIds,
          selectedConnectionId: exhaustedIds[0] ?? null,
        });
      }
      return rememberTrustedPredispatch(response, { kind: "generic-unavailable" });
    }
  }
  return args.handleSingleModel(args.body, args.unit.modelStr, {
    ...args.unit,
    effectiveComboStrategy: args.effectiveComboStrategy,
    failoverBeforeRetry: args.failoverBeforeRetry,
  });
}

function buildChildNestingContext(args: {
  context: ComboNestingContext;
  childComboName: string;
}): ComboNestingContext | Response {
  if (args.context.depth >= args.context.maxDepth) {
    return errorResponse(503, `Max combo nesting depth (${args.context.maxDepth}) exceeded`);
  }
  if (args.context.visitedComboNames.includes(args.childComboName)) {
    return errorResponse(503, `Circular combo reference detected: ${args.childComboName}`);
  }
  return {
    ...args.context,
    depth: args.context.depth + 1,
    visitedComboNames: [...args.context.visitedComboNames, args.childComboName],
  };
}

export async function executeComboRefUnit(args: {
  body: Record<string, unknown>;
  unit: ResolvedComboRefTarget;
  allCombos: ComboCollectionLike;
  runCombo: RuntimeUnitRunner;
  baseOptions: HandleComboChatOptions;
  nesting: ComboNestingContext;
}): Promise<Response> {
  const childCombo = findComboByName(args.allCombos, args.unit.comboName);
  if (!childCombo) return errorResponse(503, `Nested combo "${args.unit.comboName}" not found`);
  const childNesting = buildChildNestingContext({
    context: args.nesting,
    childComboName: childCombo.name,
  });
  if (childNesting instanceof Response) return childNesting;
  return args.runCombo({
    ...args.baseOptions,
    body: args.body,
    combo: childCombo,
    nesting: childNesting,
  });
}

async function executeRuntimeUnit(args: {
  body: Record<string, unknown>;
  unit: ResolvedComboUnit;
  allCombos: ComboCollectionLike;
  handleSingleModel: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  runCombo: RuntimeUnitRunner;
  baseOptions: HandleComboChatOptions;
  nesting: ComboNestingContext;
  failoverBeforeRetry: unknown;
  effectiveComboStrategy: string;
}): Promise<Response> {
  if (args.unit.kind === "model") {
    return executeModelUnit({
      body: args.body,
      unit: args.unit,
      handleSingleModel: args.handleSingleModel,
      isModelAvailable: args.isModelAvailable,
      failoverBeforeRetry: args.failoverBeforeRetry,
      effectiveComboStrategy: args.effectiveComboStrategy,
    });
  }
  return executeComboRefUnit({
    body: args.body,
    unit: args.unit,
    allCombos: args.allCombos,
    runCombo: args.runCombo,
    baseOptions: args.baseOptions,
    nesting: args.nesting,
  });
}

function orderUnitsForStrategy(strategy: string, units: ResolvedComboUnit[]): ResolvedComboUnit[] {
  if (strategy === "random") return shuffleUnits(units);
  if (strategy === "weighted") {
    const selected = selectWeightedUnit(units);
    if (!selected) return units;
    return [selected, ...units.filter((unit) => unit.executionKey !== selected.executionKey)];
  }
  return units;
}

export async function executeHardRuleRuntimeUnitCombo(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  units: ResolvedComboUnit[];
  handleSingleModel: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  log: ComboLogger;
  config: Record<string, unknown>;
  settings?: Record<string, unknown> | null;
  allCombos: ComboCollectionLike;
  signal?: AbortSignal | null;
  nesting: ComboNestingContext;
  baseOptions: HandleComboChatOptions;
  runCombo: RuntimeUnitRunner;
}): Promise<RuntimeUnitExecutionResult> {
  for (const originalUnit of args.units) {
    if (isNodeOffline(args.combo.name, originalUnit.stepId)) continue;
    if (originalUnit.offlineCondition === undefined) {
      const response = await executeRuntimeUnit({
        body: args.body,
        unit: originalUnit,
        allCombos: args.allCombos,
        handleSingleModel: args.handleSingleModel,
        isModelAvailable: args.isModelAvailable,
        runCombo: args.runCombo,
        baseOptions: args.baseOptions,
        nesting: args.nesting,
        failoverBeforeRetry: false,
        effectiveComboStrategy: "guarded-priority",
      });
      return { response: stripInternalGuardedHeaders(response), unit: originalUnit };
    }

    const attemptedConnections = new Set<string>();
    for (;;) {
      const unit =
        originalUnit.kind === "model" && attemptedConnections.size > 0
          ? {
              ...originalUnit,
              executionKey: `${originalUnit.executionKey}:hard-rule:${attemptedConnections.size}`,
              ...(Array.isArray(originalUnit.allowedConnectionIds)
                ? {
                    allowedConnectionIds: originalUnit.allowedConnectionIds.filter(
                      (id) => !attemptedConnections.has(id)
                    ),
                  }
                : {}),
              excludeConnectionIds: Array.from(attemptedConnections),
            }
          : originalUnit;
      if (
        unit.kind === "model" &&
        Array.isArray(unit.allowedConnectionIds) &&
        unit.allowedConnectionIds.length === 0
      )
        break;
      const response = await executeRuntimeUnit({
        body: args.body,
        unit,
        allCombos: args.allCombos,
        handleSingleModel: args.handleSingleModel,
        isModelAvailable: args.isModelAvailable,
        runCombo: args.runCombo,
        baseOptions: args.baseOptions,
        nesting: args.nesting,
        failoverBeforeRetry: false,
        effectiveComboStrategy: "guarded-priority",
      });
      // Generic pre-dispatch unavailability (no credentials / concurrent-cap /
      // circuit / plain cooldown) remains no-fallback. Trust only object-identity
      // metadata from local synthesis — never ordinary response headers.
      const trusted = getTrustedPredispatch(response);
      if (trusted?.kind === "generic-unavailable") {
        return { response: stripInternalGuardedHeaders(response), unit: originalUnit };
      }

      const exhaustedIds = trustedQuotaExhaustedConnectionIds(response);
      const facts = await buildOfflineRuleFacts(response);
      const matchesQuotaExhaustion =
        exhaustedIds.length > 0 && matchesOfflineCondition(originalUnit.offlineCondition, facts);
      const matchesUpstreamOffline =
        exhaustedIds.length === 0 && matchesOfflineCondition(originalUnit.offlineCondition, facts);

      if (!matchesQuotaExhaustion && !matchesUpstreamOffline) {
        return { response: stripInternalGuardedHeaders(response), unit: originalUnit };
      }

      const cooldownMs = Math.max(0, originalUnit.offlineCooldownMs ?? 0);
      const selectedId = selectedConnectionId(response);

      // Authoritative local quota exhaustion means the remaining credential pool is
      // empty of usable accounts (auth only returns this when every remaining
      // account is quota-blocked). Cool those concrete accounts + the node, then
      // advance to the next Guarded unit (paid nested). Peer-account selection
      // for partially-exhausted pools happens inside credential selection and
      // never reaches this allRateLimited path.
      if (exhaustedIds.length > 0 && originalUnit.kind === "model") {
        for (const id of exhaustedIds) {
          attemptedConnections.add(id);
          markConnectionRateLimitedUntil(id, cooldownMs);
        }
        if (originalUnit.connectionId) {
          markConnectionRateLimitedUntil(originalUnit.connectionId, cooldownMs);
        }
        recordNodeOffline(args.combo.name, originalUnit.stepId, cooldownMs);
        break;
      }

      if (originalUnit.kind === "model" && !originalUnit.connectionId && selectedId) {
        if (!attemptedConnections.has(selectedId)) {
          attemptedConnections.add(selectedId);
          markConnectionRateLimitedUntil(selectedId, cooldownMs);
          continue;
        }
        // Same selected connection returned after exclusion — stop account rotation.
      }
      if (originalUnit.kind === "model" && originalUnit.connectionId) {
        markConnectionRateLimitedUntil(originalUnit.connectionId, cooldownMs);
      } else if (originalUnit.kind === "model" && selectedId) {
        markConnectionRateLimitedUntil(selectedId, cooldownMs);
      }
      recordNodeOffline(args.combo.name, originalUnit.stepId, cooldownMs);
      break;
    }
  }
  return { response: errorResponse(503, "All hard-rule combo nodes are cooling down"), unit: null };
}

export async function executeRuntimeUnitCombo(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  strategy: string;
  effectiveComboStrategy?: string;
  units: ResolvedComboUnit[];
  handleSingleModel: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  log: ComboLogger;
  config: Record<string, unknown>;
  settings?: Record<string, unknown> | null;
  allCombos: ComboCollectionLike;
  signal?: AbortSignal | null;
  nesting: ComboNestingContext;
  baseOptions: HandleComboChatOptions;
  runCombo: RuntimeUnitRunner;
}): Promise<RuntimeUnitExecutionResult> {
  const maxRetries = Number(args.config.maxRetries ?? 1);
  const retryDelayMs = resolveDelayMs(args.config.retryDelayMs, 2000);
  const orderedUnits = orderUnitsForStrategy(args.strategy, args.units);
  const clientRequestedStream = args.body?.stream === true;
  const startTime = Date.now();
  const effectiveStrategy = args.effectiveComboStrategy ?? args.strategy;
  let lastResponse: Response | null = null;
  let fallbackCount = 0;

  for (const unit of orderedUnits) {
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      if (args.signal?.aborted)
        return { response: errorResponse(499, "Client disconnected"), unit };
      args.nesting.attemptBudget.count += 1;
      if (args.nesting.attemptBudget.count > args.nesting.attemptBudget.limit) {
        return { response: errorResponse(503, "Maximum combo retry limit reached"), unit };
      }
      if (retry > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      args.log.info(
        "COMBO",
        `Trying ${unit.kind} ${unitDisplayName(unit)}${retry > 0 ? ` (retry ${retry})` : ""}`
      );
      const response = await executeRuntimeUnit({
        body: args.body,
        unit,
        allCombos: args.allCombos,
        handleSingleModel: args.handleSingleModel,
        isModelAvailable: args.isModelAvailable,
        runCombo: args.runCombo,
        baseOptions: args.baseOptions,
        nesting: args.nesting,
        failoverBeforeRetry: args.config.failoverBeforeRetry,
        effectiveComboStrategy: effectiveStrategy,
      });
      lastResponse = response;
      if (response.ok) {
        if (unit.kind === "combo-ref") {
          recordComboRequest(args.combo.name, null, {
            success: true,
            latencyMs: Date.now() - startTime,
            fallbackCount,
            strategy: effectiveStrategy,
            target: { executionKey: unit.executionKey, stepId: unit.stepId, label: unit.label },
          });
          return { response, unit };
        }
        let unitClone: Response;
        try {
          unitClone = response.clone();
        } catch {
          unitClone = response;
        }
        const quality = await validateResponseQuality(
          unitClone,
          clientRequestedStream,
          args.log,
          args.config.responseValidation as ResponseValidationConfig | undefined
        );
        releaseQualityClone(unitClone, response, quality);
        if (quality.valid) {
          recordComboRequest(args.combo.name, unit.modelStr, {
            success: true,
            latencyMs: Date.now() - startTime,
            fallbackCount,
            strategy: effectiveStrategy,
            target: { executionKey: unit.executionKey, stepId: unit.stepId, label: unit.label },
          });
          return { response, unit };
        }
      }
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    }
    fallbackCount += 1;
  }
  recordComboRequest(args.combo.name, null, {
    success: false,
    latencyMs: Date.now() - startTime,
    fallbackCount,
    strategy: effectiveStrategy,
  });
  return {
    response: lastResponse || errorResponse(503, "All nested combo units unavailable"),
    unit: null,
  };
}
