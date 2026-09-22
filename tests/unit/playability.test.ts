import { describe, expect, it, vi } from "vitest";
import { PongEngine } from "../../lib/game/engine";
import { GAME, type DifficultyLevel } from "../../lib/game/constants";
import { predictIntercept } from "../../lib/game/prediction";
import { DecisionController } from "../../lib/agent/decision-controller";
import { MockProvider } from "../../lib/agent/providers/mock";
import type { AgentDecisionResponse } from "../../lib/agent/contracts";

// Only the wall-clock sleep is replaced. Decisions still use the application's
// actual mock provider, normalizer, confidence policy, controller and physics.
vi.mock("../../lib/agent/providers/provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/agent/providers/provider")>();
  return { ...actual, delay: async () => {} };
});

async function flush() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

async function simulateMatch(
  latencyMs: number,
  aimOffset: number,
  options: {
    level?: DifficultyLevel;
    seed?: number;
    durationSeconds?: number;
  } = {},
) {
  const engine = new PongEngine(options.level ?? 1);
  const mock = new MockProvider({ seed: options.seed ?? 42, latencyMs: 0 });
  let now = 0;
  let requests = 0;
  let playingMs = 0;
  let nextHumanInput = 0;
  let totalRallyHits = 0;
  const points = { human: 0, ai: 0 };
  const hits = { human: 0, ai: 0 };
  let completedMatches = 0;
  const returns: Array<{ due: number; deliver: () => void }> = [];
  const controller = new DecisionController(engine, {
    now: () => now,
    timeoutMs: 1400,
    requestDecision: async (snapshot, signal) => {
      requests++;
      const result = await mock.decide(snapshot, {
        requestId: `simulation-${requests}`,
        signal,
      });
      return new Promise<AgentDecisionResponse>((resolve) => {
        returns.push({ due: now + latencyMs, deliver: () => resolve(result) });
      });
    },
  });
  engine.start();
  for (let frame = 0; frame < 60 * (options.durationSeconds ?? 600); frame++) {
    now = frame * (1000 / 60);
    if (now >= nextHumanInput) {
      const intercept = predictIntercept(
        engine.state.ball,
        GAME.humanX + GAME.paddleWidth / 2 + GAME.ballRadius,
      ).interceptY;
      const target = intercept ?? GAME.height / 2;
      const variety = [-1, 0, 1, 0.4, -0.7, 0.8, 0, -0.95, 0.9, -0.2];
      engine.setHumanTarget(
        target +
          aimOffset *
            variety[
              (engine.state.hits.human + engine.state.roundId * 3) %
                variety.length
            ],
      );
      nextHumanInput = now + 140;
    }
    controller.update(now);
    await flush();
    for (let index = returns.length - 1; index >= 0; index--) {
      if (returns[index].due <= now) returns.splice(index, 1)[0].deliver();
    }
    await flush();
    if (engine.state.phase === "playing") playingMs += 1000 / 60;
    engine.update(1 / 60);
    for (const event of engine.consumeEvents()) {
      if (event.type === "hit") totalRallyHits++;
      if (event.type === "hit" && event.side) hits[event.side]++;
      if (event.type === "score" && event.side) points[event.side]++;
    }
    if (engine.state.phase === "finished") {
      completedMatches++;
      if (!options.durationSeconds) break;
      engine.restart();
      controller.reset();
    }
  }
  const result = {
    latencyMs,
    aimOffset,
    level: engine.state.difficulty,
    seed: options.seed ?? 42,
    score: { ...engine.state.score },
    points,
    hits,
    completedMatches,
    playingSeconds: playingMs / 1000,
    finished: engine.state.phase === "finished",
    seconds: Math.round(now / 1000),
    longestRally: engine.state.longestRally,
    averageRally: Number(
      (
        totalRallyHits /
        Math.max(1, engine.state.score.ai + engine.state.score.human)
      ).toFixed(1),
    ),
    requests,
    decisionsPerPlayingSecond: Number(
      (requests / (playingMs / 1000)).toFixed(2),
    ),
    fallbackCount: controller.telemetry.fallbackCount,
  };
  controller.dispose();
  return result;
}

describe("deterministic playability benchmark", () => {
  it("measures complete matches with the actual mock provider at realistic latency", async () => {
    const results: Array<Awaited<ReturnType<typeof simulateMatch>>> = [];
    for (const [latency, aim] of [
      [80, 58],
      [240, 58],
      [500, 58],
      [80, 72],
      [240, 72],
    ])
      results.push(await simulateMatch(latency, aim));
    console.info("Playability benchmark:", JSON.stringify(results));
    for (const result of results) {
      expect(result.finished).toBe(true);
      expect(Math.max(result.score.human, result.score.ai)).toBe(7);
      expect(result.decisionsPerPlayingSecond).toBeLessThan(3.5);
      expect(result.fallbackCount).toBe(0);
      expect(result.longestRally).toBeGreaterThan(2);
      expect(result.averageRally).toBeGreaterThan(3);
      expect(result.averageRally).toBeLessThan(40);
    }
  }, 30_000);

  it("substantially reduces player scoring across paired levels, seeds and network latency", async () => {
    const results: Array<Awaited<ReturnType<typeof simulateMatch>>> = [];
    // Equal wall-clock windows, player policy, seeds and latency across all
    // levels. Finished matches restart; an unfinished game is never a win.
    for (const seed of [42, 101])
      for (const latency of [80, 500])
        for (const level of [1, 2, 3] as const)
          results.push(
            await simulateMatch(latency, 58, {
              level,
              seed,
              durationSeconds: 180,
            }),
          );
    const summaries = ([1, 2, 3] as const).map((level) => {
      const runs = results.filter((result) => result.level === level);
      const playingSeconds = runs.reduce(
        (sum, result) => sum + result.playingSeconds,
        0,
      );
      const playerPoints = runs.reduce(
        (sum, result) => sum + result.points.human,
        0,
      );
      const agentReturns = runs.reduce(
        (sum, result) => sum + result.hits.ai,
        0,
      );
      return {
        level,
        playerPoints,
        agentReturns,
        playerPointsPerMinute: (playerPoints / playingSeconds) * 60,
        agentReturnsPerMinute: (agentReturns / playingSeconds) * 60,
      };
    });
    console.info(
      "Difficulty benchmark (mock decisions):",
      JSON.stringify({
        summaries,
        runs: results.map(
          ({ level, seed, latencyMs, points, completedMatches }) => ({
            level,
            seed,
            latencyMs,
            points,
            completedMatches,
          }),
        ),
      }),
    );
    expect(summaries[1].playerPointsPerMinute).toBeLessThan(
      summaries[0].playerPointsPerMinute,
    );
    expect(summaries[2].playerPointsPerMinute).toBeLessThan(
      summaries[0].playerPointsPerMinute * 0.5,
    );
    expect(summaries[2].playerPointsPerMinute).toBeLessThanOrEqual(
      summaries[1].playerPointsPerMinute,
    );
    expect(summaries[2].agentReturnsPerMinute).toBeGreaterThan(
      summaries[0].agentReturnsPerMinute,
    );
  }, 30_000);
});
