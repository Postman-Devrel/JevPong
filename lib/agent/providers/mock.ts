import type { AgentGameState, Movement, ReturnStyle } from "../contracts";
import { normalizeJevResponse } from "./jev";
import {
  delay,
  ProviderError,
  type AgentProvider,
  type ProviderContext,
  type ProviderResult,
} from "./provider";

function seededValue(seed: number): number {
  let value = (seed | 0) + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

function distribution<K extends string>(
  keys: readonly K[],
  selected: K,
  confidence: number,
  split: number,
): Record<K, number> {
  const result = {} as Record<K, number>;
  const alternatives = keys.filter((key) => key !== selected);
  result[selected] = confidence;
  result[alternatives[0]] = (1 - confidence) * split;
  result[alternatives[1]] = (1 - confidence) * (1 - split);
  return result;
}

export interface MockProviderOptions {
  seed?: number;
  latencyMs?: number;
  timeoutMs?: number;
}

/** Fully deterministic decisions for a seed, sequence and state; simulated usage is never billable. */
export class MockProvider implements AgentProvider {
  constructor(private readonly options: MockProviderOptions = {}) {}

  async decide(
    state: AgentGameState,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const started = performance.now();
    const scenario = context.scenario ?? "normal";
    if (scenario === "timeout") {
      await delay(this.options.timeoutMs ?? 900, context.signal);
      throw new ProviderError("timeout");
    }
    await delay(this.options.latencyMs ?? 72, context.signal);
    if (scenario === "rate_limit") throw new ProviderError("rate_limit", 1_500);
    if (scenario === "provider_error")
      throw new ProviderError("provider_error", 750);
    if (scenario === "invalid_response")
      throw new ProviderError("invalid_response", 750);

    const noise = seededValue(
      (this.options.seed ?? 42) + state.sequence * 17 + state.roundId * 103,
    );
    const target =
      state.ball.movingTowardAgent && state.prediction.interceptY !== null
        ? state.prediction.interceptY
        : state.arena.height / 2;
    const distance = target - state.agentPaddle.centerY;
    const deadzone = Math.max(16, state.agentPaddle.height * 0.21);
    const movement: Movement =
      distance < -deadzone ? "UP" : distance > deadzone ? "DOWN" : "HOLD";
    const ambiguous = state.prediction.uncertaintyPx > state.agentPaddle.height;
    const movementProbability =
      scenario === "low_confidence"
        ? 0.36
        : ambiguous
          ? 0.48 + noise * 0.08
          : 0.76 + noise * 0.2;
    const movementConfidence =
      scenario === "low_confidence"
        ? 0.12
        : ambiguous
          ? 0.46
          : 0.7 + noise * 0.27;
    let style: ReturnStyle = "SAFE";
    if (state.agent.strategy === "aggressive")
      style = noise > 0.45 ? "FAST" : "ANGLED";
    else if (state.agent.strategy === "balanced" && state.match.rallyLength > 2)
      style =
        Math.abs(state.humanPaddle.centerY - state.arena.height / 2) > 70
          ? "ANGLED"
          : noise > 0.52
            ? "FAST"
            : "SAFE";
    const styleProbability = 0.64 + noise * 0.28;
    const needsBoost =
      state.ball.movingTowardAgent &&
      state.agentPaddle.boostReady &&
      (state.prediction.timeToImpactMs ?? Infinity) < 450 &&
      Math.abs(distance) > state.agentPaddle.height;
    const raw = {
      model: "jev-mock-v1",
      answers: {
        movement: {
          type: "choice",
          choice: movement,
          probabilities: distribution(
            ["UP", "DOWN", "HOLD"] as const,
            movement,
            movementProbability,
            scenario === "low_confidence" ? 0.5 : 0.6,
          ),
          confidence: movementConfidence,
        },
        return_style: {
          type: "choice",
          choice: style,
          probabilities: distribution(
            ["SAFE", "ANGLED", "FAST"] as const,
            style,
            styleProbability,
            0.6,
          ),
          confidence: 0.56 + noise * 0.35,
        },
        use_boost: {
          type: "noul",
          noul: needsBoost ? 0.82 + noise * 0.15 : 0.03 + noise * 0.12,
        },
      },
      usage: { input_tokens: 570 + Math.floor(noise * 95), output_tokens: 65 },
    };
    const result = normalizeJevResponse(
      raw,
      state,
      context.requestId,
      performance.now() - started,
    );
    result.decision.source = "mock";
    result.decision.usage.billable = false;
    return { ...result, rawResponse: { simulated: true, ...raw } };
  }
}
