/** Official pricing verified 2026-09-21: https://docs.typesafe.ai/models */
export interface AgentPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}
export const DEFAULT_PRICING: Readonly<AgentPricing> = Object.freeze({
  inputPerMillionUsd: 0.042,
  outputPerMillionUsd: 0,
});
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  billable?: boolean;
}

export function estimateCostUsd(
  usage: TokenUsage,
  pricing: AgentPricing = DEFAULT_PRICING,
): number {
  if (usage.billable === false) return 0;
  const input = Number.isFinite(usage.inputTokens)
    ? Math.max(0, usage.inputTokens)
    : 0;
  const output = Number.isFinite(usage.outputTokens)
    ? Math.max(0, usage.outputTokens)
    : 0;
  return (
    (input * pricing.inputPerMillionUsd +
      output * pricing.outputPerMillionUsd) /
    1_000_000
  );
}
