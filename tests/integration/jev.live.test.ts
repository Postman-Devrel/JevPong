import { describe, expect, it } from "vitest";
import { JevProvider } from "../../lib/agent/providers/jev";
import { getServerConfig } from "../../lib/agent/providers/config";
import type { AgentGameState } from "../../lib/agent/contracts";
import { baseState, decisionFixtures } from "../fixtures/agent-states";

const liveCases: [string, AgentGameState][] =
  process.env.JEV_LIVE_FIXTURES === "1"
    ? Object.entries(decisionFixtures)
    : [["smoke", baseState]];

// Deliberate opt-in only. Set the key in your shell; do not paste it into test output.
describe.skipIf(process.env.JEV_LIVE_TEST !== "1")(
  "live TypeSafe smoke test",
  () => {
    it.each(liveCases)(
      "evaluates the %s snapshot with the official provider",
      async (name, snapshot) => {
        const config = getServerConfig();
        expect(
          config.configured,
          "Configure either direct TypeSafe credentials or a paired Jev Gateway URL and key.",
        ).toBe(true);
        const provider = new JevProvider({
          apiKey: config.apiKey,
          baseURL: config.apiBaseURL,
          gatewayApiKey: config.gatewayApiKey,
          model: config.model,
          timeoutMs: 5_000,
        });
        const result = await provider.decide(snapshot, {
          requestId: "live-smoke-test",
        });
        expect(result.decision.source).toBe("jev");
        expect(result.decision.model).toMatch(/^jev-/);
        expect(result.decision.usage.inputTokens).toBeGreaterThan(0);
        expect(result.decision.shotTarget).toMatch(/^(UPPER|CENTER|LOWER)$/);
        console.info({
          fixture: name,
          model: result.decision.model,
          movement: result.decision.movement,
          movementConfidence: result.decision.movementConfidence,
          returnStyle: result.decision.returnStyle,
          shotTarget: result.decision.shotTarget,
          shotTargetConfidence: result.decision.shotTargetConfidence,
          useBoostProbability: result.decision.useBoostProbability,
          adapterMs: Math.round(result.decision.timing.serverMs),
          usage: result.decision.usage,
        });
      },
      10_000,
    );
  },
);
