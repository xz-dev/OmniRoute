/**
 * TEMPORARY diagnostic-only catalog stage profiler.
 *
 * Grep / delete key: [DEBUG-catalog-profile-9199]
 * Safe fields only — never log headers, keys, URLs, query values, model IDs,
 * DB values, response bodies, or errors/stacks.
 *
 * Remove this file and every call site tagged [DEBUG-catalog-profile-9199] when done.
 */

const TAG = "[DEBUG-catalog-profile-9199]";

export type CatalogProfileCacheOutcome = "fresh" | "stale" | "cold" | "joined";
export type CatalogProfilePrefixCategory = "alias" | "canonical" | "dual" | "default";

export type CatalogProfileFields = {
  stage: string;
  buildId?: number;
  joinedBuildId?: number;
  elapsedMs?: number;
  deltaMs?: number;
  modelCount?: number;
  count?: number;
  status?: number;
  cacheOutcome?: CatalogProfileCacheOutcome;
  prefixCategory?: CatalogProfilePrefixCategory;
  configuredOnly?: boolean;
  generation?: number;
  scheduledGeneration?: number;
  ordinal?: number;
  durationMs?: number;
};

let nextBuildId = 0;

// [DEBUG-catalog-profile-9199] request-scoped correlation — never attach to Request
const requestBuildIds = new WeakMap<Request, number>();

export function catalogProfileNextBuildId(): number {
  nextBuildId += 1;
  return nextBuildId;
}

/** Read an already-bound request build id, if any. */
export function catalogProfileGetRequestBuildId(request: Request): number | undefined {
  return requestBuildIds.get(request);
}

/**
 * Bind `buildId` to `request`, or allocate a new monotonic id when unbound.
 * Same Request object keeps the same id across getUnifiedModelsResponse →
 * resolveCachedCatalogResponse / runBuilder / background task → core builder.
 */
export function catalogProfileEnsureRequestBuildId(request: Request, buildId?: number): number {
  if (buildId !== undefined) {
    requestBuildIds.set(request, buildId);
    return buildId;
  }
  const existing = requestBuildIds.get(request);
  if (existing !== undefined) return existing;
  const allocated = catalogProfileNextBuildId();
  requestBuildIds.set(request, allocated);
  return allocated;
}

export function catalogProfileNow(): number {
  return performance.now();
}

export function catalogProfilePrefixCategory(request: Request): CatalogProfilePrefixCategory {
  try {
    const prefix = new URL(request.url).searchParams.get("prefix");
    if (prefix === "alias" || prefix === "canonical" || prefix === "dual") return prefix;
  } catch {
    // ignore — category stays default
  }
  return "default";
}

export function catalogProfileConfiguredOnly(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get("configuredOnly") === "true";
  } catch {
    return false;
  }
}

export function catalogProfileLog(fields: CatalogProfileFields): void {
  const parts: string[] = [TAG];
  if (fields.buildId !== undefined) parts.push(`buildId=${fields.buildId}`);
  if (fields.joinedBuildId !== undefined) parts.push(`joinedBuildId=${fields.joinedBuildId}`);
  parts.push(`stage=${fields.stage}`);
  if (fields.elapsedMs !== undefined) parts.push(`elapsedMs=${Math.round(fields.elapsedMs)}`);
  if (fields.deltaMs !== undefined) parts.push(`deltaMs=${Math.round(fields.deltaMs)}`);
  if (fields.modelCount !== undefined) parts.push(`modelCount=${fields.modelCount}`);
  if (fields.count !== undefined) parts.push(`count=${fields.count}`);
  if (fields.status !== undefined) parts.push(`status=${fields.status}`);
  if (fields.cacheOutcome !== undefined) parts.push(`cacheOutcome=${fields.cacheOutcome}`);
  if (fields.prefixCategory !== undefined) parts.push(`prefixCategory=${fields.prefixCategory}`);
  if (fields.configuredOnly !== undefined) parts.push(`configuredOnly=${fields.configuredOnly}`);
  if (fields.generation !== undefined) parts.push(`generation=${fields.generation}`);
  if (fields.scheduledGeneration !== undefined) {
    parts.push(`scheduledGeneration=${fields.scheduledGeneration}`);
  }
  if (fields.ordinal !== undefined) parts.push(`ordinal=${fields.ordinal}`);
  if (fields.durationMs !== undefined) parts.push(`durationMs=${Math.round(fields.durationMs)}`);
  try {
    console.log(parts.join(" "));
  } catch {
    // Temporary diagnostics must never affect catalog behavior.
  }
}

export type CatalogProfileSession = {
  readonly buildId: number;
  currentStage: string;
  mark: (
    stage: string,
    extra?: Omit<CatalogProfileFields, "stage" | "buildId" | "elapsedMs" | "deltaMs">
  ) => void;
  startWatchdog: () => () => void;
};

/**
 * @param initialStage first stage label
 * @param buildId optional pre-allocated / request-correlated id (same numeric id across layers)
 */
export function createCatalogProfileSession(
  initialStage = "entry",
  buildId?: number
): CatalogProfileSession {
  const resolvedBuildId = buildId ?? catalogProfileNextBuildId();
  const startedAt = catalogProfileNow();
  let lastAt = startedAt;
  let currentStage = initialStage;

  const mark: CatalogProfileSession["mark"] = (stage, extra) => {
    const now = catalogProfileNow();
    const elapsedMs = now - startedAt;
    const deltaMs = now - lastAt;
    lastAt = now;
    currentStage = stage;
    catalogProfileLog({
      stage,
      buildId: resolvedBuildId,
      elapsedMs,
      deltaMs,
      ...extra,
    });
  };

  const startWatchdog = (): (() => void) => {
    const timer = setInterval(() => {
      catalogProfileLog({
        stage: `watchdog:${currentStage}`,
        buildId: resolvedBuildId,
        elapsedMs: catalogProfileNow() - startedAt,
      });
    }, 2000);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return () => {
      clearInterval(timer);
    };
  };

  return {
    buildId: resolvedBuildId,
    get currentStage() {
      return currentStage;
    },
    set currentStage(value: string) {
      currentStage = value;
    },
    mark,
    startWatchdog,
  };
}
