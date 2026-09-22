import { describe, expect, it, vi } from "vitest";
import {
  DecisionController,
  createFallbackDecision,
} from "../../lib/agent/decision-controller";
import { explainDecision } from "../../lib/agent/explanation";
import type {
  AgentDecisionResponse,
  AgentGameState,
} from "../../lib/agent/contracts";
import { PongEngine } from "../../lib/game/engine";
import type { DifficultyLevel } from "../../lib/game/constants";

function playing(level: DifficultyLevel = 1) {
  const engine = new PongEngine(level);
  engine.start();
  for (let i = 0; i < 360; i++) engine.update(1 / 120);
  Object.assign(engine.state.ball, {
    x: 500,
    y: 300,
    vx: 330,
    vy: 100,
    speed: 345,
  });
  return engine;
}

function response(snapshot: AgentGameState): AgentDecisionResponse {
  return {
    decision: {
      ...createFallbackDecision(snapshot, "timeout"),
      source: "mock",
      movementConfidence: 0.9,
      model: "mock-jev",
    },
    rawResponse: { mock: true },
  };
}

async function flush() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("decision request lifecycle", () => {
  it("keeps one request in flight and runs the canvas without waiting", async () => {
    const engine = playing();
    const pending = deferred<AgentDecisionResponse>();
    const requestDecision = vi.fn((snapshot: AgentGameState) => {
      void snapshot;
      return pending.promise;
    });
    let receiptNow = 0;
    const controller = new DecisionController(engine, {
      requestDecision,
      now: () => receiptNow,
    });
    controller.update(0);
    await flush();
    controller.update(250);
    controller.update(500);
    receiptNow = 507;
    expect(requestDecision).toHaveBeenCalledTimes(1);
    const x = engine.state.ball.x;
    engine.update(0.1);
    expect(engine.state.ball.x).toBeGreaterThan(x);
    pending.resolve(response(requestDecision.mock.calls[0][0]));
    await flush();
    expect(controller.telemetry.lastApplied?.accepted).toBe(true);
    expect(controller.telemetry.smoothedLatencyMs).toBe(507);
    controller.dispose();
  });

  it("aborts a timed-out call and visibly enters non-boosting fallback", async () => {
    const engine = playing();
    let signal: AbortSignal | undefined;
    const onDecision = vi.fn();
    const controller = new DecisionController(engine, {
      requestDecision: (_snapshot, requestSignal) => {
        signal = requestSignal;
        return new Promise(() => {});
      },
      timeoutMs: 900,
      onDecision,
    });
    controller.update(0);
    await flush();
    controller.update(901);
    expect(signal?.aborted).toBe(true);
    expect(controller.telemetry.lastDecision?.source).toBe("fallback");
    expect(controller.telemetry.lastDecision?.fallbackReason).toBe("timeout");
    expect(controller.telemetry.lastApplied?.useBoost).toBe(false);
    expect(onDecision).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("discards a late response after a paddle hit or match restart", async () => {
    const engine = playing();
    const pending = deferred<AgentDecisionResponse>();
    let snapshot!: AgentGameState;
    const onStale = vi.fn();
    let receiptNow = 0;
    const controller = new DecisionController(engine, {
      now: () => receiptNow,
      requestDecision: (state) => {
        snapshot = state;
        return pending.promise;
      },
      onStale,
    });
    controller.update(0);
    await flush();
    engine.state.directionVersion++;
    receiptNow = 139.6;
    pending.resolve(response(snapshot));
    await flush();
    expect(controller.telemetry.rejectedCount).toBe(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale.mock.calls[0][0].timing.roundTripMs).toBe(139.6);
    expect(controller.telemetry.lastApplied).toBeNull();
    controller.dispose();
  });

  it("turns low confidence into explicit fallback while preserving real usage and votes", async () => {
    const engine = playing();
    const controller = new DecisionController(engine, {
      requestDecision: async (snapshot) => {
        const value = response(snapshot);
        Object.assign(value.decision, {
          source: "jev",
          movement: "UP",
          movementConfidence: 0.049,
          usage: { inputTokens: 81, outputTokens: 23 },
        });
        return value;
      },
    });
    controller.update(0);
    await flush();
    expect(controller.telemetry.lastDecision?.source).toBe("fallback");
    expect(controller.telemetry.lastDecision?.movement).toBe("UP");
    expect(controller.telemetry.lastDecision?.usage).toEqual({
      inputTokens: 81,
      outputTokens: 23,
      billable: true,
    });
    expect(controller.telemetry.lastApplied?.movement).toBe("DOWN");
    expect(controller.telemetry.lastApplied?.returnStyle).toBe("SAFE");
    controller.dispose();
  });

  it("accepts movement confidence at the fallback boundary", async () => {
    const engine = playing();
    const controller = new DecisionController(engine, {
      requestDecision: async (snapshot) => {
        const value = response(snapshot);
        Object.assign(value.decision, {
          source: "jev",
          movement: "UP",
          movementConfidence: 0.05,
          fallbackReason: undefined,
        });
        return value;
      },
    });
    controller.update(0);
    await flush();
    expect(controller.telemetry.lastDecision?.source).toBe("jev");
    expect(controller.telemetry.lastDecision?.fallbackReason).toBeUndefined();
    controller.dispose();
  });

  it("recovers from fallback even when the next response takes longer than the polling interval", async () => {
    const engine = playing();
    const recovery = deferred<AgentDecisionResponse>();
    let nextSnapshot!: AgentGameState;
    let calls = 0;
    const controller = new DecisionController(engine, {
      requestDecision: async (snapshot) => {
        if (calls++ === 0) throw new Error("offline");
        nextSnapshot = snapshot;
        return recovery.promise;
      },
    });
    controller.update(0);
    await flush();
    expect(controller.telemetry.lastDecision?.source).toBe("fallback");
    controller.update(300);
    await flush();
    controller.update(600);
    controller.update(900);
    recovery.resolve(response(nextSnapshot));
    await flush();
    expect(controller.telemetry.lastDecision?.source).toBe("mock");
    expect(controller.telemetry.rejectedCount).toBe(0);
    controller.dispose();
  });

  it("honours retry-after and disabled provider responses without request spam", async () => {
    const engine = playing();
    const requestDecision = vi.fn(async (snapshot: AgentGameState) => ({
      decision: createFallbackDecision(snapshot, "rate_limit"),
      rawResponse: { error: "rate_limit" },
      retryAfterMs: 2000,
    }));
    const controller = new DecisionController(engine, { requestDecision });
    controller.update(0);
    await flush();
    engine.state.directionVersion++;
    controller.update(1000);
    await flush();
    expect(requestDecision).toHaveBeenCalledTimes(1);
    controller.update(2001);
    await flush();
    expect(requestDecision).toHaveBeenCalledTimes(2);
    controller.suspendRequests("missing credentials");
    controller.update(10000);
    expect(requestDecision).toHaveBeenCalledTimes(2);
    expect(controller.telemetry.lastApplied?.source).toBe("fallback");
    controller.dispose();
  });

  it("samples away travel occasionally and immediately refreshes a changed direction without a pending request", async () => {
    const engine = playing();
    engine.state.ball.vx = -330;
    const requestDecision = vi.fn(async (snapshot: AgentGameState) =>
      response(snapshot),
    );
    const controller = new DecisionController(engine, { requestDecision });
    controller.update(0);
    await flush();
    for (const now of [250, 500, 899]) {
      controller.update(now);
      await flush();
    }
    expect(requestDecision).toHaveBeenCalledTimes(1);
    controller.update(900);
    await flush();
    expect(requestDecision).toHaveBeenCalledTimes(2);
    engine.state.ball.vx = 330;
    engine.state.directionVersion++;
    controller.update(920);
    await flush();
    expect(requestDecision).toHaveBeenCalledTimes(3);
    engine.state.roundId++;
    controller.update(930);
    await flush();
    expect(requestDecision).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  it("updates configuration without resetting request identity", async () => {
    const engine = playing();
    const requestDecision = vi.fn(async (snapshot: AgentGameState) =>
      response(snapshot),
    );
    const controller = new DecisionController(engine, { requestDecision });
    controller.update(0);
    await flush();
    controller.configure({ intervalMs: 100, timeoutMs: 1800 });
    controller.update(250);
    await flush();
    controller.update(350);
    await flush();
    expect(
      requestDecision.mock.calls.map(([snapshot]) => snapshot.sequence),
    ).toEqual([1, 2, 3]);
    controller.dispose();
  });

  it.each([
    [1, 900],
    [2, 500],
    [3, 300],
  ] as const)(
    "uses the level %i recovery interval",
    async (level, recoveryInterval) => {
      const engine = playing(level);
      engine.state.ball.vx = -330;
      const requestDecision = vi.fn(async (snapshot: AgentGameState) =>
        response(snapshot),
      );
      const controller = new DecisionController(engine, { requestDecision });
      controller.update(0);
      await flush();
      controller.update(recoveryInterval - 1);
      await flush();
      expect(requestDecision).toHaveBeenCalledTimes(1);
      controller.update(recoveryInterval);
      await flush();
      expect(requestDecision).toHaveBeenCalledTimes(2);
      controller.dispose();
    },
  );

  it("aborts an in-flight decision on a difficulty change and rejects a late response", async () => {
    const engine = playing(3);
    const pending = deferred<AgentDecisionResponse>();
    let snapshot!: AgentGameState;
    let signal!: AbortSignal;
    const controller = new DecisionController(engine, {
      requestDecision: (state, requestSignal) => {
        snapshot = state;
        signal = requestSignal;
        return pending.promise;
      },
    });
    controller.update(0);
    await flush();
    engine.setDifficulty(2);
    controller.update(100);
    expect(signal.aborted).toBe(true);
    pending.resolve(response(snapshot));
    await flush();
    expect(controller.telemetry.lastApplied).toBeNull();
    expect(controller.telemetry.rejectedCount).toBe(1);
    expect(engine.state.movement).toBe("HOLD");
    controller.dispose();
  });

  it("handles invalid payloads without throwing into the animation loop", async () => {
    const engine = playing();
    const controller = new DecisionController(engine, {
      requestDecision: async () =>
        ({ decision: {}, rawResponse: {} }) as AgentDecisionResponse,
    });
    controller.update(0);
    await flush();
    expect(controller.telemetry.lastDecision?.fallbackReason).toBe(
      "invalid_response",
    );
    controller.dispose();
  });
});

describe("observable decision explanations", () => {
  it("describes probabilities and code boundaries, and labels fallback honestly", () => {
    const engine = playing();
    const snapshot = engine.createSnapshot(1);
    const mock = response(snapshot).decision;
    expect(explainDecision(snapshot, mock)).toContain("predicted intercept");
    expect(explainDecision(snapshot, mock)).toContain("Code bounds movement");
    expect(
      explainDecision(snapshot, createFallbackDecision(snapshot, "timeout")),
    ).toContain("Simple code");
  });
});
