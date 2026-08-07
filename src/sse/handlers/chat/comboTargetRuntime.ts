export interface ComboTargetRuntime {
  allowRateLimitedConnection?: boolean;
  connectionId?: string | null;
  executionKey?: string | null;
  stepId?: string | null;
  allowedConnectionIds?: string[] | null;
  excludeConnectionIds?: string[] | null;
  failoverBeforeRetry?: boolean;
  providerId?: string | null;
  effectiveComboStrategy?: string | null;
  modelAbortSignal?: AbortSignal | null;
}

export function mergeExcludedConnectionIds(
  excludedConnectionIds: Set<string>,
  requestedExclusions: string[] | null | undefined
): string[] {
  return [...new Set([...excludedConnectionIds, ...(requestedExclusions ?? [])])];
}
