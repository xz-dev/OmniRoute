const offlineUntil = new Map<string, number>();

export function offlineNodeKey(parentCombo: string, stepId: string): string {
  return `${parentCombo}\u0000${stepId}`;
}

export function recordNodeOffline(
  parentCombo: string,
  stepId: string,
  cooldownMs: number,
  now = Date.now()
): void {
  offlineUntil.set(offlineNodeKey(parentCombo, stepId), now + Math.max(0, cooldownMs));
}

export function isNodeOffline(parentCombo: string, stepId: string, now = Date.now()): boolean {
  const key = offlineNodeKey(parentCombo, stepId);
  const until = offlineUntil.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    offlineUntil.delete(key);
    return false;
  }
  return true;
}

export function clearNodeOfflineState(): void {
  offlineUntil.clear();
}
