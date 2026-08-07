type Translator = ((key: string) => string) & { has?: (key: string) => boolean };

const STRATEGY_RECOMMENDATIONS = {
  priority: {
    title: "Fail-safe baseline",
    description: "Use one primary model and keep fallback chain short and reliable.",
    tips: [
      "Put your most reliable model first.",
      "Keep 1-2 backup models with similar quality.",
      "Use safe retries to absorb transient provider failures.",
    ],
  },
  weighted: {
    title: "Controlled traffic split",
    description: "Great for canary rollouts and gradual migration between models.",
    tips: [
      "Start with conservative split like 90/10.",
      "Keep the total at 100% and auto-balance after changes.",
      "Monitor success and latency before increasing canary weight.",
    ],
  },
  "round-robin": {
    title: "Predictable load sharing",
    description: "Best when models are equivalent and you need smooth distribution.",
    tips: [
      "Use at least 2 models.",
      "Set concurrency limits to avoid burst overload.",
      "Use queue timeout to fail fast under saturation.",
    ],
  },
  "context-relay": {
    title: "Session continuity first",
    description:
      "Best when account rotation is expected and the next account must inherit a condensed task summary.",
    tips: [
      "Use with providers that rotate accounts for the same model family.",
      "Keep the handoff threshold below the hard quota cutoff to give the summary time to generate.",
      "Set a dedicated summary model only when the primary model is too expensive or unstable.",
    ],
  },
  random: {
    title: "Quick spread with low setup",
    description: "Use when you need simple distribution without strict guarantees.",
    tips: [
      "Use models with similar latency profiles.",
      "Keep retries enabled to absorb random misses.",
      "Prefer this for experimentation, not strict SLAs.",
    ],
  },
  "least-used": {
    title: "Adaptive balancing",
    description: "Routes to less-used models to reduce hotspots over time.",
    tips: [
      "Works better under continuous traffic.",
      "Combine with health checks for safer balancing.",
      "Track per-model usage to validate distribution gains.",
    ],
  },
  "cost-optimized": {
    title: "Budget-first routing",
    description: "Routes to lower-cost models when pricing metadata is available.",
    tips: [
      "Ensure pricing coverage for all selected models.",
      "Keep a quality fallback for hard prompts.",
      "Use for batch/background jobs where cost is the main KPI.",
    ],
  },
  "reset-aware": {
    title: "Reset-aware account rotation",
    description: "Balances remaining provider quota against reset timing.",
    tips: [
      "Use explicit account steps or account-tag routing for providers with quota telemetry.",
      "Tune session vs weekly weights when short-term exhaustion is more risky.",
      "Keep the tie band small so equivalent accounts still rotate fairly.",
    ],
  },
  "fill-first": {
    title: "Quota drain strategy",
    description: "Exhausts one provider's quota before moving to the next in chain.",
    tips: [
      "Order models by free quota size — biggest first.",
      "Enable health checks to skip drained providers.",
      "Ideal for free-tier stacking (Deepgram → Groq → NIM).",
    ],
  },
  p2c: {
    title: "Power-of-Two-Choices",
    description:
      "Picks the less-loaded of two random candidates per request — low latency at scale.",
    tips: [
      "Use with 4+ models for best effect.",
      "Requires latency telemetry enabled in Settings.",
      "Great replacement for round-robin in high-throughput combos.",
    ],
  },
  "strict-random": {
    title: "Shuffle deck distribution",
    description: "Each model is used exactly once per cycle before reshuffling.",
    tips: [
      "Use at least 2 models for meaningful distribution.",
      "Ideal for same-model accounts to evenly spread quota.",
      "Guarantees no model is skipped or repeated within a cycle.",
    ],
  },
  auto: {
    title: "Multi-factor optimization",
    description: "Routes based on real-time scoring of cost, latency, quality, and health.",
    tips: [
      "Let the engine balance across multiple factors automatically.",
      "Monitor which factors drive routing decisions in the logs.",
      "Use for complex workloads where no single factor dominates.",
    ],
  },
  lkgp: {
    title: "History-based routing",
    description: "Routes based on historical success rates and persistent performance data.",
    tips: [
      "Let success history accumulate before relying on this strategy.",
      "Models with better track records get preference over time.",
      "Ideal for stable workloads with consistent model availability.",
    ],
  },
  "context-optimized": {
    title: "Context-aware distribution",
    description: "Routes to optimize context window usage and conversation continuity.",
    tips: [
      "Best for long conversations that span multiple requests.",
      "Selects models with appropriate context capacity automatically.",
      "Use when context limits are a bottleneck for your workload.",
    ],
  },
} as const;

type Strategy = keyof typeof STRATEGY_RECOMMENDATIONS;
type RecommendationField = "title" | "description" | "tips";

function translateOrFallback(t: Translator, key: string, fallback: string): string {
  try {
    if (typeof t.has === "function" && t.has(key)) return t(key);
  } catch {}
  return fallback;
}

export function getStrategyRecommendationText(
  t: Translator,
  strategy: string,
  field: RecommendationField
): string | string[] {
  const normalized = strategy in STRATEGY_RECOMMENDATIONS ? (strategy as Strategy) : "priority";
  const fallback = STRATEGY_RECOMMENDATIONS[normalized];
  if (field === "tips") {
    return fallback.tips.map((tip, index) =>
      translateOrFallback(t, `strategyRecommendations.${strategy}.tip${index + 1}`, tip)
    );
  }
  return translateOrFallback(t, `strategyRecommendations.${strategy}.${field}`, fallback[field]);
}
