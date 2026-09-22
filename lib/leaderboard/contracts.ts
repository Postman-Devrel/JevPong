import { z } from "zod";
import { GAME } from "../game/constants";

export const LEADERBOARD_VERSION = "jev-pong-1";
export const MAX_MATCH_MS = 2 * 60 * 60 * 1000;
export const levelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(18)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} _.'-]*$/u,
    "Start with a letter or number; use letters, numbers, spaces, or . _ ' -",
  );

export const startMatchSchema = z
  .object({
    clientMatchId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9-]+$/),
    playerName: nicknameSchema,
    difficulty: levelSchema,
    strategy: z.enum(["balanced", "aggressive", "defensive"]),
  })
  .strict();

export const finishMatchSchema = z
  .object({
    ticket: z.string().min(1).max(3000),
    durationMs: z.number().int().min(1).max(MAX_MATCH_MS),
    humanScore: z.number().int().min(0).max(GAME.winningScore),
    aiScore: z.number().int().min(0).max(GAME.winningScore),
    liveDecisions: z.number().int().min(0).max(100000),
    fallbackDecisions: z.number().int().min(0).max(100000),
    mockDecisions: z.number().int().min(0).max(100000),
    strategyChanged: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      (value.humanScore === GAME.winningScore &&
        value.aiScore < GAME.winningScore) ||
      (value.aiScore === GAME.winningScore &&
        value.humanScore < GAME.winningScore),
    "A completed match has exactly one winner",
  );

export const entrySchema = z.object({
  matchId: z.string(),
  playerName: z.string().max(18),
  rank: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  humanScore: z.number().int(),
  aiScore: z.number().int(),
  completedAt: z.string(),
});
export const boardSchema = z.object({
  difficulty: levelSchema,
  entries: z.array(entrySchema).max(20),
  totalPlayers: z.number().int().nonnegative(),
  personalBest: entrySchema.nullable(),
  updatedAt: z.string(),
});
export const resultSchema = z.object({
  matchId: z.string(),
  ranked: z.boolean(),
  reason: z
    .enum([
      "loss",
      "practice",
      "fallback",
      "strategy",
      "no_live_decisions",
      "insufficient_live_decisions",
      "hidden",
    ])
    .nullable(),
  rank: z.number().int().positive().nullable(),
  personalBest: z.boolean(),
  durationMs: z.number().int().positive(),
  board: boardSchema,
});
export const startResponseSchema = z.object({
  ticket: z.string(),
  matchId: z.string(),
});
export type Leaderboard = z.infer<typeof boardSchema>;
export type MatchResult = z.infer<typeof resultSchema>;
export type FinishMatch = z.infer<typeof finishMatchSchema>;
export type StartMatch = z.infer<typeof startMatchSchema>;

/** The leaderboard uses hundredths; ties at this precision share a rank. */
export function formatRaceTime(milliseconds: number): string {
  const hundredths = Math.round(milliseconds / 10);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor(hundredths / 100) % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}
