import { z } from "zod";

export const MOVEMENTS = ["UP", "DOWN", "HOLD"] as const;
export const RETURN_STYLES = ["SAFE", "ANGLED", "FAST"] as const;
export const STRATEGIES = ["balanced", "aggressive", "defensive"] as const;
export const MOCK_SCENARIOS = [
  "normal",
  "timeout",
  "rate_limit",
  "provider_error",
  "low_confidence",
  "invalid_response",
] as const;
export type Movement = (typeof MOVEMENTS)[number];
export type ReturnStyle = (typeof RETURN_STYLES)[number];
export type Strategy = (typeof STRATEGIES)[number];
export type MockScenario = (typeof MOCK_SCENARIOS)[number];
export type DecisionSource = "jev" | "mock" | "fallback";
export type FallbackReason =
  | "low_confidence"
  | "timeout"
  | "rate_limit"
  | "provider_error"
  | "invalid_response"
  | "missing_credentials"
  | "authentication"
  | "configuration"
  | "offline";

const finite = z.number().finite();
const coordinate = finite.min(-20_000).max(20_000);
const velocity = finite.min(-20_000).max(20_000);
const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
const nonnegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Logical pixels; velocities are logical pixels per second; durations are milliseconds. */
export const agentGameStateSchema = z
  .object({
    sequence: nonnegativeInteger,
    capturedAtMs: finite.nonnegative(),
    matchId: identifier,
    roundId: nonnegativeInteger,
    directionVersion: nonnegativeInteger,
    arena: z
      .object({
        width: finite.positive().max(10_000),
        height: finite.positive().max(10_000),
      })
      .strict(),
    ball: z
      .object({
        x: coordinate,
        y: coordinate,
        velocityX: velocity,
        velocityY: velocity,
        speed: finite.nonnegative().max(20_000),
        movingTowardAgent: z.boolean(),
      })
      .strict(),
    agentPaddle: z
      .object({
        centerY: coordinate,
        velocityY: velocity,
        height: finite.positive().max(10_000),
        boostReady: z.boolean(),
      })
      .strict(),
    humanPaddle: z
      .object({ centerY: coordinate, velocityY: velocity })
      .strict(),
    prediction: z
      .object({
        interceptY: coordinate.nullable(),
        timeToImpactMs: finite.nonnegative().max(1_000_000).nullable(),
        uncertaintyPx: finite.nonnegative().max(20_000),
      })
      .strict(),
    match: z
      .object({
        humanScore: nonnegativeInteger,
        agentScore: nonnegativeInteger,
        rallyLength: nonnegativeInteger,
      })
      .strict(),
    agent: z
      .object({
        strategy: z.enum(STRATEGIES),
        previousMovement: z.enum(MOVEMENTS),
        previousReturnStyle: z.enum(RETURN_STYLES),
        smoothedLatencyMs: finite.nonnegative().max(1_000_000).nullable(),
      })
      .strict(),
  })
  .strict();

export type AgentGameState = z.infer<typeof agentGameStateSchema>;
export type AgentSnapshot = AgentGameState;

export interface AgentDecision {
  sequence: number;
  matchId: string;
  roundId: number;
  directionVersion: number;
  requestId: string;
  movement: Movement;
  movementProbabilities: Record<Movement, number>;
  movementConfidence: number;
  returnStyle: ReturnStyle;
  returnStyleProbabilities: Record<ReturnStyle, number>;
  returnStyleConfidence: number;
  useBoostProbability: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number; billable?: boolean };
  timing: {
    serverMs: number;
    providerMs: number | null;
    roundTripMs: number | null;
  };
  source: DecisionSource;
  fallbackReason?: FallbackReason;
}

export const decisionRequestSchema = z
  .object({
    state: agentGameStateSchema,
    scenario: z.enum(MOCK_SCENARIOS).optional(),
  })
  .strict();
export type AgentDecisionRequest = z.infer<typeof decisionRequestSchema>;
export interface AgentDecisionResponse {
  decision: AgentDecision;
  rawResponse: unknown;
  retryAfterMs?: number;
  disabled?: boolean;
}

export const agentPublicConfigSchema = z
  .object({
    provider: z.enum(["jev", "mock"]),
    model: z
      .string()
      .min(1)
      .max(100)
      .regex(/^jev-[a-zA-Z0-9.-]+$/),
    configured: z.boolean(),
    decisionIntervalMs: z.number().int().min(150).max(2_000),
    requestTimeoutMs: z.number().int().min(100).max(5_000),
    pricing: z
      .object({
        inputPerMillionUsd: finite.min(0).max(1_000),
        outputPerMillionUsd: finite.min(0).max(1_000),
      })
      .strict(),
    mockScenariosEnabled: z.boolean(),
  })
  .strict()
  .refine(
    (config) => config.provider === "mock" || !config.mockScenariosEnabled,
    { message: "Live mode cannot enable mock scenarios" },
  );
export type AgentPublicConfig = z.infer<typeof agentPublicConfigSchema>;
