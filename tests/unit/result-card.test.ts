import { describe, expect, it } from "vitest";
import {
  normalizePlayerName,
  resultFilename,
  resultHeadline,
  resultLeaderboardSummary,
  resultShareText,
  type ResultCardData,
} from "../../lib/share/result-card";

const result: ResultCardData = {
  playerName: "  Ada   Lovelace  ",
  humanScore: 7,
  agentScore: 4,
  winner: "human",
  longestRally: 12,
  decisions: 83,
  fallbackRate: 0.12,
  latencyP50Ms: 221,
  model: "jev-test",
};

describe("shareable result card data", () => {
  it("normalizes a short display name without accepting control characters", () => {
    expect(normalizePlayerName("  Ada\n\tLovelace  ")).toBe("Ada Lovelace");
    expect(normalizePlayerName("   ")).toBe("PLAYER 01");
    expect(normalizePlayerName("A name that is much too long")).toHaveLength(
      18,
    );
  });

  it("creates outcome-aware copy and a safe filename", () => {
    expect(resultHeadline(result)).toBe("I BEAT JEV.");
    expect(resultShareText(result)).toBe(
      "Ada Lovelace beat Jev 7–4. Can you beat the machine?",
    );
    expect(resultFilename(result)).toBe("jev-pong-ada-lovelace-7-4.png");
    expect(resultHeadline({ ...result, winner: "ai" })).toBe("I TOOK ON JEV.");
  });

  it("includes the played difficulty in shared results", () => {
    const hardResult = { ...result, difficulty: 3 as const };
    expect(resultShareText(hardResult)).toBe(
      "Ada Lovelace beat Jev 7–4 on Hard. Can you beat the machine?",
    );
    expect(resultFilename(hardResult)).toBe(
      "jev-pong-ada-lovelace-7-4-hard.png",
    );
  });

  it("uses the retained personal best as the current leaderboard rank", () => {
    const ranked = {
      ...result,
      difficulty: 2 as const,
      leaderboard: {
        status: "ranked" as const,
        rank: 12,
        durationMs: 65_430,
        totalPlayers: 84,
        reason: null,
      },
    };
    expect(resultLeaderboardSummary(ranked)).toEqual({
      label: "CURRENT MEDIUM RANK",
      value: "#12",
      detail: "PERSONAL BEST 1:05.43  /  84 PLAYERS",
    });
    expect(resultShareText(ranked)).toBe(
      "Ada Lovelace beat Jev 7–4 on Medium. Current rank: #12 with a 1:05.43 personal best. Can you beat the machine?",
    );
  });

  it("explains why a match has no qualifying rank", () => {
    expect(
      resultLeaderboardSummary({
        ...result,
        difficulty: 1,
        leaderboard: {
          status: "unranked",
          rank: null,
          durationMs: null,
          totalPlayers: 20,
          reason: "fallback",
        },
      }),
    ).toEqual({
      label: "EASY LEADERBOARD",
      value: "NOT RANKED",
      detail: "FALLBACK PLAY",
    });
  });
});
