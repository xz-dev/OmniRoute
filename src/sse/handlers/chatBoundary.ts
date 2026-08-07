export function isGuardedPriorityStrategy(strategy: string | null | undefined): boolean {
  return strategy === "guarded-priority";
}

export function shouldReturnSelectedResponseToGuardedExecutor(
  strategy: string | null | undefined,
  succeeded: boolean
): boolean {
  return isGuardedPriorityStrategy(strategy) && !succeeded;
}

export function shouldUseGlobalFallbackForCombo(
  strategy: string | null | undefined,
  response: Response,
  fallbackModel: unknown
): boolean {
  return (
    !isGuardedPriorityStrategy(strategy) &&
    !response.ok &&
    [502, 503].includes(response.status) &&
    typeof fallbackModel === "string" &&
    fallbackModel.trim().length > 0
  );
}
