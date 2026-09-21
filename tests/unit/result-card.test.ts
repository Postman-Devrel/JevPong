import { describe, expect, it } from "vitest";
import {
  normalizePlayerName,
  resultFilename,
  resultHeadline,
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
});
