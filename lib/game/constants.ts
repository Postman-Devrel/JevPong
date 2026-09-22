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
  humanBoostSpeed: 1120,
  boostDuration: 0.32,
  boostCooldown: 2.6,
  winningScore: 7,
  countdownSeconds: 3,
  fixedStep: 1 / 120,
  returnLease: 1.25,
} as const;

/** Shared action gates. Each difficulty profile defines its own speed and timing. */
export const ACTION_POLICY = {
  fullMovementConfidence: 0.55,
  minimumMovementConfidence: 0.05,
  minimumReturnConfidence: 0.3,
  boostProbability: 0.65,
  decisionIntervalMs: 250,
  timeoutMs: 1200,
} as const;

export type DifficultyLevel = 1 | 2 | 3;
export const DEFAULT_DIFFICULTY: DifficultyLevel = 3;

export interface DifficultyProfile {
  level: DifficultyLevel;
  label: string;
  description: string;
  aiSpeed: number;
  aiBoostSpeed: number;
  aiRecenterSpeedScale: number;
  cautiousSpeedScale: number;
  movementLeaseMs: number;
  maxMovementLeaseMs: number;
  awayDecisionIntervalMs: number;
  shotPlacementEnabled: boolean;
  maxShotAngleRadians: number;
}

/** Per-match limits. The same model chooses actions at every level. */
export const DIFFICULTY_LEVELS: Readonly<
  Record<DifficultyLevel, Readonly<DifficultyProfile>>
> = {
  1: {
    level: 1,
    label: "Easy",
    description: "Slower movement and forgiving returns.",
    aiSpeed: 150,
    aiBoostSpeed: 240,
    aiRecenterSpeedScale: 0.45,
    cautiousSpeedScale: 0.7,
    movementLeaseMs: 450,
    maxMovementLeaseMs: 450,
    awayDecisionIntervalMs: 900,
    shotPlacementEnabled: false,
    maxShotAngleRadians: 1.04,
  },
  2: {
    level: 2,
    label: "Medium",
    description: "Quicker recovery and placed shots.",
    aiSpeed: 300,
    aiBoostSpeed: 480,
    aiRecenterSpeedScale: 0.7,
    cautiousSpeedScale: 0.85,
    movementLeaseMs: 750,
    maxMovementLeaseMs: 1300,
    awayDecisionIntervalMs: 500,
    shotPlacementEnabled: true,
    maxShotAngleRadians: 0.9,
  },
  3: {
    level: 3,
    label: "Hard",
    description: "Fast recovery and attacking placement.",
    aiSpeed: 450,
    aiBoostSpeed: 680,
    aiRecenterSpeedScale: 1,
    cautiousSpeedScale: 1,
    movementLeaseMs: 1000,
    maxMovementLeaseMs: 1600,
    awayDecisionIntervalMs: 300,
    shotPlacementEnabled: true,
    maxShotAngleRadians: 1.04,
  },
};

/** Let a model-selected action bridge inference while retaining a hard expiry. */
export function movementLeaseMsFor(
  profile: Readonly<DifficultyProfile>,
  latencyMs: number | null = null,
): number {
  const latency =
    latencyMs !== null && Number.isFinite(latencyMs)
      ? Math.max(0, latencyMs)
      : 0;
  return Math.min(
    profile.maxMovementLeaseMs,
    Math.max(
      profile.movementLeaseMs,
      latency + ACTION_POLICY.decisionIntervalMs + 100,
    ),
  );
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
