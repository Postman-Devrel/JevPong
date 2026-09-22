import { describe, expect, it } from "vitest";
import type { AgentDecision, AgentGameState } from "../../lib/agent/contracts";
import { SessionTelemetry } from "../../lib/telemetry/session";
import { baseState } from "../fixtures/agent-states";

function snapshot(sequence = 1): AgentGameState {
  return {
    ...structuredClone(baseState),
    sequence,
    capturedAtMs: 0,
    matchId: "match-test",
    roundId: 1,
    directionVersion: 1,
    arena: { width: 960, height: 540 },
    ball: {
      x: 480,
      y: 270,
      velocityX: 300,
      velocityY: 0,
      speed: 300,
      movingTowardAgent: true,
    },
    agentPaddle: { centerY: 200, velocityY: 0, height: 96, boostReady: true },
    humanPaddle: { ...baseState.humanPaddle, centerY: 270, velocityY: 0 },
    prediction: {
      ...baseState.prediction,
      interceptY: 270,
      timeToImpactMs: 1_400,
      uncertaintyPx: 3,
      reachableMaxY: 492,
      boostReachableMaxY: 492,
    },
    match: { humanScore: 0, agentScore: 0, rallyLength: 1 },
    agent: {
      strategy: "balanced",
      previousMovement: "HOLD",
      previousReturnStyle: "SAFE",
      smoothedLatencyMs: null,
    },
  };
}

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    sequence: 1,
    matchId: "match-test",
    roundId: 1,
    directionVersion: 1,
    requestId: "safe-request-id",
    movement: "DOWN",
    movementProbabilities: { UP: 0.05, DOWN: 0.8, HOLD: 0.15 },
    movementConfidence: 0.8,
    returnStyle: "SAFE",
    returnStyleProbabilities: { SAFE: 0.8, ANGLED: 0.1, FAST: 0.1 },
    returnStyleConfidence: 0.8,
    useBoostProbability: 0.3,
    model: "jev-test-version",
    usage: { inputTokens: 1_000, outputTokens: 100, billable: true },
    timing: { serverMs: 45, providerMs: null, roundTripMs: 60 },
    source: "jev",
    ...overrides,
  };
}

describe("browser session telemetry", () => {
  it("separates mock token counts from real usage and uses configured prices", () => {
    const session = new SessionTelemetry({
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      now: () => 0,
    });
    session.record(snapshot(), decision(), {});
    session.record(
      snapshot(2),
      decision({
        sequence: 2,
        source: "mock",
        usage: { inputTokens: 9_000, outputTokens: 900, billable: false },
      }),
      {},
    );
    expect(session.getMetrics()).toMatchObject({
      accepted: 2,
      inputTokens: 1_000,
      outputTokens: 100,
      simulatedInputTokens: 9_000,
      simulatedOutputTokens: 900,
    });
    expect(session.getMetrics().estimatedCostUsd).toBeCloseTo(0.0024);
  });

  it("charges returned Jev tokens when confidence gating selects fallback", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    session.record(
      snapshot(),
      decision({ source: "fallback", fallbackReason: "low_confidence" }),
      {},
    );
    session.record(snapshot(2), decision({ sequence: 2 }), {});
    expect(session.getMetrics()).toMatchObject({
      fallbackCount: 1,
      fallbackRate: 0.5,
      inputTokens: 2_000,
      outputTokens: 200,
    });
    expect(session.getMetrics().estimatedCostUsd).toBeCloseTo(0.000084);
    expect(
      session.exportSession({ human: 0, agent: 0 }, null)
        .fallbackAndErrorEvents,
    ).toEqual([
      expect.objectContaining({ kind: "fallback", reason: "low_confidence" }),
    ]);
  });

  it("records discarded requests without treating them as accepted actions", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    session.recordStale(decision());
    session.recordStale();
    expect(session.getMetrics()).toMatchObject({
      accepted: 0,
      staleDiscarded: 2,
      observedResponses: 1,
      inputTokens: 1_000,
      decisionsPerSecond: 0,
      fallbackRate: 0,
    });
    expect(session.getHistory()).toHaveLength(0);
  });

  it("measures accepted decisions over a rolling five-second window", () => {
    let now = 0;
    const session = new SessionTelemetry({ now: () => now });
    for (let i = 0; i < 20; i++) {
      now = i * 250;
      session.record(snapshot(i), decision({ sequence: i }), {});
    }
    expect(session.getMetrics().decisionsPerSecond).toBe(4);
    now = 5_000;
    expect(session.getMetrics().decisionsPerSecond).toBe(3.8);
    now = 10_000;
    expect(session.getMetrics().decisionsPerSecond).toBe(0);
  });

  it("keeps 50 immutable decisions and the latest 100 measured latencies", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    for (let i = 0; i < 150; i++) {
      session.record(
        snapshot(i),
        decision({
          sequence: i,
          timing: { serverMs: 1, providerMs: null, roundTripMs: i },
        }),
        {},
      );
    }
    const history = session.getHistory();
    expect(history).toHaveLength(50);
    expect(history[0].decision.sequence).toBe(149);
    history[0].decision.model = "tampered";
    expect(session.getHistory()[0].decision.model).toBe("jev-test-version");
    expect(session.getMetrics()).toMatchObject({
      latencySamples: 100,
      latencyP50Ms: 99,
      latencyP95Ms: 144,
      latestLatencyMs: 149,
    });
    expect(
      session.exportSession({ human: 7, agent: 5 }, "human").retention,
    ).toMatchObject({ omittedDecisions: 100, truncated: true });
  });

  it("does not invent latency values when timing is unavailable", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    session.record(
      snapshot(),
      decision({
        timing: { serverMs: 40, providerMs: null, roundTripMs: null },
      }),
      {},
    );
    expect(session.getMetrics()).toMatchObject({
      latestLatencyMs: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      latencySamples: 0,
    });
  });

  it("redacts nested credentials, request headers, environment and stack data on export", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    session.record(snapshot(), decision(), {
      model: "jev-test-version",
      apiKey: "super-private-key",
      nested: {
        authorization: "Bearer hidden-token",
        headers: { "x-secret": "hidden-header" },
        environment: { INNOCENT: "hidden-environment" },
        stack: "hidden-stack",
      },
    });
    const exported = session.exportSession({ human: 7, agent: 3 }, "human", {
      match: { winningScore: 7 },
      model: { provider: "jev", TYPESAFE_API_KEY: "hidden-config" },
    });
    const json = JSON.stringify(exported);
    for (const secret of [
      "super-private-key",
      "hidden-token",
      "hidden-header",
      "hidden-environment",
      "hidden-stack",
      "hidden-config",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(exported).toMatchObject({
      appVersion: "1.0.0",
      score: { human: 7, agent: 3 },
      outcome: "human",
      matchConfiguration: { winningScore: 7 },
      metrics: { inputTokens: 1_000 },
    });
    expect(exported.events).toHaveLength(1);
  });

  it("labels truncated provider inspection data instead of growing without bounds", () => {
    const session = new SessionTelemetry({ now: () => 0 });
    const event = session.record(snapshot(), decision(), {
      rows: Array.from({ length: 400 }, () => "a".repeat(100)),
    });
    expect(event.rawResponse).toMatchObject({ truncated: true });
    expect(JSON.stringify(event.rawResponse).length).toBeLessThan(25_000);
    expect(
      session.exportSession({ human: 1, agent: 0 }, null).events[0],
    ).toMatchObject({
      decision: { sequence: 1 },
      rawResponse: { truncated: true },
    });
  });
});
