import type {
  AgentDecision,
  AgentGameState,
  FallbackReason,
  MockScenario,
  Movement,
} from "../contracts";

export interface ProviderContext {
  requestId: string;
  signal?: AbortSignal;
  scenario?: MockScenario;
}
export interface ProviderResult {
  decision: AgentDecision;
  rawResponse: unknown;
}
export interface AgentProvider {
  decide(
    state: AgentGameState,
    context: ProviderContext,
  ): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: FallbackReason,
    public readonly retryAfterMs?: number,
    public readonly disabled = false,
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

export function decisionIdentity(state: AgentGameState, requestId: string) {
  return {
    sequence: state.sequence,
    matchId: state.matchId,
    roundId: state.roundId,
    directionVersion: state.directionVersion,
    requestId,
  };
}

export function fallbackDecision(
  state: AgentGameState,
  requestId: string,
  reason: FallbackReason,
  serverMs = 0,
): AgentDecision {
  const target =
    state.ball.movingTowardAgent && state.prediction.interceptY !== null
      ? state.prediction.interceptY
      : state.arena.height / 2;
  const distance = target - state.agentPaddle.centerY;
  const deadzone = Math.max(12, state.agentPaddle.height * 0.2);
  const movement: Movement =
    distance < -deadzone ? "UP" : distance > deadzone ? "DOWN" : "HOLD";
  return {
    ...decisionIdentity(state, requestId),
    movement,
    movementProbabilities: {
      UP: movement === "UP" ? 1 : 0,
      DOWN: movement === "DOWN" ? 1 : 0,
      HOLD: movement === "HOLD" ? 1 : 0,
    },
    // These are deterministic controller values, never a model's confidence.
    movementConfidence: 0,
    returnStyle: "SAFE",
    returnStyleProbabilities: { SAFE: 1, ANGLED: 0, FAST: 0 },
    returnStyleConfidence: 0,
    shotTarget: "CENTER",
    shotTargetProbabilities: { UPPER: 0, CENTER: 1, LOWER: 0 },
    shotTargetConfidence: 0,
    useBoostProbability: 0,
    model: "deterministic-fallback",
    usage: { inputTokens: 0, outputTokens: 0, billable: false },
    timing: { serverMs, providerMs: null, roundTripMs: null },
    source: "fallback",
    fallbackReason: reason,
  };
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.ceil(milliseconds)
    : undefined;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("timeout"));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new ProviderError("timeout"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
