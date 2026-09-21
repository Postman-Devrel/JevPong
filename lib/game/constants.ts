export const GAME = {
  width: 960,
  height: 600,
  paddleWidth: 14,
  humanPaddleHeight: 120,
  aiPaddleHeight: 96,
  humanX: 38,
  aiX: 922,
  ballRadius: 8,
  initialBallSpeed: 330,
  maxBallSpeed: 680,
  ballAcceleration: 18,
  humanSpeed: 760,
  aiSpeed: 150,
  humanBoostSpeed: 1120,
  aiBoostSpeed: 240,
  aiRecenterSpeedScale: 0.45,
  boostDuration: 0.32,
  boostCooldown: 2.6,
  winningScore: 7,
  countdownSeconds: 3,
  fixedStep: 1 / 120,
  movementLease: 0.45,
  returnLease: 1.25,
} as const;

/** Tunable action policy, separate from the model's probability estimates. */
export const ACTION_POLICY = {
  // Live-session tuning: keep Jev in control unless its movement signal is
  // genuinely weak. Middling confidence remains visibly speed-limited.
  fullMovementConfidence: 0.55,
  minimumMovementConfidence: 0.18,
  cautiousSpeedScale: 0.7,
  minimumReturnConfidence: 0.3,
  boostProbability: 0.65,
  decisionIntervalMs: 250,
  awayDecisionIntervalMs: 900,
  timeoutMs: 1200,
} as const;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
