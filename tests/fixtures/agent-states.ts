import type { AgentGameState } from "../../lib/agent/contracts";

export const baseState: AgentGameState = {
  sequence: 1,
  capturedAtMs: 1_250,
  matchId: "fixture-match",
  roundId: 1,
  directionVersion: 1,
  difficulty: 3,
  arena: { width: 960, height: 600 },
  ball: {
    x: 600,
    y: 150,
    velocityX: 390,
    velocityY: 120,
    speed: Math.hypot(390, 120),
    movingTowardAgent: true,
  },
  agentPaddle: { centerY: 300, velocityY: 0, height: 96, boostReady: true },
  humanPaddle: { centerY: 270, velocityY: 0, height: 120, maxSpeed: 760 },
  capabilities: {
    movementSpeed: 450,
    boostSpeed: 680,
    cautiousSpeedScale: 1,
    recenterSpeedScale: 1,
    boostDurationMs: 320,
    boostCooldownMs: 2_600,
    boostCooldownRemainingMs: 0,
    movementLeaseMs: 1_000,
    shotPlacementEnabled: true,
    maxShotAngleRadians: 1.04,
    maxBallSpeed: 680,
  },
  prediction: {
    interceptY: 220,
    timeToImpactMs: 760,
    uncertaintyPx: 0,
    reachableMinY: 48,
    reachableMaxY: 552,
    boostReachableMinY: 48,
    boostReachableMaxY: 552,
  },
  match: { humanScore: 1, agentScore: 2, rallyLength: 4 },
  agent: {
    strategy: "balanced",
    previousMovement: "HOLD",
    previousReturnStyle: "SAFE",
    smoothedLatencyMs: 90,
  },
};

function variant(
  overrides: Partial<Omit<AgentGameState, "prediction">> & {
    prediction?: Partial<AgentGameState["prediction"]>;
  },
): AgentGameState {
  const state = {
    ...structuredClone(baseState),
    ...overrides,
    prediction: { ...baseState.prediction, ...overrides.prediction },
  };
  const seconds = Math.min(
    state.capabilities.movementLeaseMs / 1_000,
    Math.max(
      0,
      ((state.prediction.timeToImpactMs ?? state.capabilities.movementLeaseMs) -
        (state.agent.smoothedLatencyMs ?? 0)) /
        1_000,
    ),
  );
  const reach = state.capabilities.movementSpeed * seconds;
  const boostedReach = state.agentPaddle.boostReady
    ? reach +
      (state.capabilities.boostSpeed - state.capabilities.movementSpeed) *
        Math.min(seconds, state.capabilities.boostDurationMs / 1_000)
    : reach;
  const halfHeight = state.agentPaddle.height / 2;
  Object.assign(state.prediction, {
    reachableMinY: Math.max(halfHeight, state.agentPaddle.centerY - reach),
    reachableMaxY: Math.min(
      state.arena.height - halfHeight,
      state.agentPaddle.centerY + reach,
    ),
    boostReachableMinY: Math.max(
      halfHeight,
      state.agentPaddle.centerY - boostedReach,
    ),
    boostReachableMaxY: Math.min(
      state.arena.height - halfHeight,
      state.agentPaddle.centerY + boostedReach,
    ),
  });
  return state;
}

export const decisionFixtures: Record<string, AgentGameState> = {
  approachingAbove: variant({
    prediction: { interceptY: 80, timeToImpactMs: 750, uncertaintyPx: 0 },
  }),
  approachingBelow: variant({
    prediction: { interceptY: 520, timeToImpactMs: 750, uncertaintyPx: 0 },
  }),
  aligned: variant({
    prediction: { interceptY: 300, timeToImpactMs: 500, uncertaintyPx: 0 },
  }),
  fastApproach: variant({
    ball: { ...baseState.ball, velocityX: 800, speed: 810 },
    prediction: { interceptY: 60, timeToImpactMs: 200, uncertaintyPx: 12 },
  }),
  movingAway: variant({
    ball: { ...baseState.ball, velocityX: -390, movingTowardAgent: false },
    agentPaddle: { ...baseState.agentPaddle, centerY: 100 },
    prediction: { interceptY: null, timeToImpactMs: null, uncertaintyPx: 0 },
  }),
  boostUnavailable: variant({
    agentPaddle: { ...baseState.agentPaddle, boostReady: false },
    prediction: { interceptY: 60, timeToImpactMs: 200, uncertaintyPx: 0 },
  }),
  boostAvailable: variant({
    agentPaddle: { ...baseState.agentPaddle, boostReady: true },
    prediction: { interceptY: 60, timeToImpactMs: 200, uncertaintyPx: 0 },
  }),
  aggressive: variant({
    agent: { ...baseState.agent, strategy: "aggressive" },
  }),
  defensive: variant({ agent: { ...baseState.agent, strategy: "defensive" } }),
  balanced: variant({ agent: { ...baseState.agent, strategy: "balanced" } }),
  ambiguous: variant({
    prediction: { interceptY: 210, timeToImpactMs: 420, uncertaintyPx: 180 },
  }),
};

/** Representative official shape; recorded as a fixture, not represented as a live call. */
export const officialResponseFixture = {
  model: "jev-1.13.0",
  answers: {
    movement: {
      type: "choice",
      choice: "UP",
      probabilities: { UP: 0.86, DOWN: 0.04, HOLD: 0.1 },
      confidence: 0.78,
    },
    return_style: {
      type: "choice",
      choice: "SAFE",
      probabilities: { SAFE: 0.71, ANGLED: 0.21, FAST: 0.08 },
      confidence: 0.62,
    },
    shot_target: {
      type: "choice",
      choice: "LOWER",
      probabilities: { UPPER: 0.08, CENTER: 0.14, LOWER: 0.78 },
      confidence: 0.7,
    },
    use_boost: { type: "noul", noul: 0.12 },
  },
  usage: { input_tokens: 630, output_tokens: 65 },
};
