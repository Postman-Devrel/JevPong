import { describe, expect, it } from "vitest";
import { PongEngine } from "../../lib/game/engine";
import { GAME, type DifficultyLevel } from "../../lib/game/constants";
import { predictIntercept, reflectY } from "../../lib/game/prediction";
import { createFallbackDecision } from "../../lib/agent/decision-controller";
import type { AgentDecision } from "../../lib/agent/contracts";
import { agentGameStateSchema } from "../../lib/agent/contracts";

function advance(engine: PongEngine, seconds: number, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += step)
    engine.update(Math.min(step, seconds - elapsed));
}

function playing(level: DifficultyLevel = 1) {
  const engine = new PongEngine(level);
  engine.start();
  advance(engine, 3);
  return engine;
}

function decision(engine: PongEngine, overrides: Partial<AgentDecision> = {}) {
  return {
    ...createFallbackDecision(engine.createSnapshot(1), "timeout"),
    source: "mock" as const,
    movement: "DOWN" as const,
    movementConfidence: 0.9,
    ...overrides,
  };
}

function towardAgent(engine: PongEngine) {
  Object.assign(engine.state.ball, {
    x: 500,
    y: 300,
    vx: 330,
    vy: 100,
    speed: Math.hypot(330, 100),
  });
}

describe("deterministic Pong physics", () => {
  it("starts with a three-count and produces identical motion at different frame rates", () => {
    const a = playing();
    const b = playing();
    expect(a.state.phase).toBe("playing");
    expect(a.state.ball.speed).toBe(GAME.initialBallSpeed);
    advance(a, 0.5, 1 / 30);
    advance(b, 0.5, 1 / 120);
    expect(a.state.ball.x).toBeCloseTo(b.state.ball.x, 8);
    expect(a.state.ball.y).toBeCloseTo(b.state.ball.y, 8);
  });

  it("catches a maximum-speed paddle collision without tunnelling", () => {
    const engine = playing();
    Object.assign(engine.state.ball, {
      x: 65,
      y: 300,
      vx: -680,
      vy: 0,
      speed: 680,
    });
    engine.update(0.1);
    expect(engine.state.ball.vx).toBeGreaterThan(0);
    expect(engine.state.rally).toBe(1);
    expect(engine.state.score.ai).toBe(0);
    expect(engine.state.ball.speed).toBeLessThanOrEqual(GAME.maxBallSpeed);
  });

  it("caps speed and prevents almost vertical returns on edge contact", () => {
    const engine = playing();
    Object.assign(engine.state.ball, {
      x: 58,
      y: 360,
      vx: -680,
      vy: 0,
      speed: 680,
    });
    engine.update(1 / 60);
    expect(engine.state.ball.speed).toBe(GAME.maxBallSpeed);
    expect(Math.abs(engine.state.ball.vx)).toBeGreaterThan(
      GAME.maxBallSpeed * 0.5,
    );
    expect(
      engine
        .consumeEvents()
        .some((event) => event.type === "boost" && event.side === "human"),
    ).toBe(true);
  });

  it("reflects off walls while preserving speed and horizontal direction version", () => {
    const engine = playing();
    Object.assign(engine.state.ball, {
      x: 500,
      y: 9,
      vx: 200,
      vy: -300,
      speed: Math.hypot(200, 300),
    });
    const version = engine.state.directionVersion;
    engine.update(1 / 60);
    expect(engine.state.ball.vy).toBe(300);
    expect(engine.state.ball.y).toBeGreaterThanOrEqual(GAME.ballRadius);
    expect(engine.state.directionVersion).toBe(version);
  });

  it("scores each miss once, counts to seven, and resets a new match", () => {
    const engine = playing();
    const originalId = engine.state.matchId;
    for (let index = 0; index < 7; index++) {
      engine.state.phase = "playing";
      Object.assign(engine.state.ball, { x: 970, y: 100, vx: 330, vy: 0 });
      engine.update(1 / 60);
      expect(engine.state.score.human).toBe(index + 1);
      if (index < 6) expect(engine.state.phase).toBe("countdown");
    }
    expect(engine.state.phase).toBe("finished");
    expect(engine.state.winner).toBe("human");
    advance(engine, 1);
    expect(engine.state.score.human).toBe(7);
    engine.restart();
    expect(engine.state.matchId).not.toBe(originalId);
    expect(engine.state.score.human).toBe(0);
    expect(engine.state.phase).toBe("countdown");
  });

  it("pauses immediately and resumes the same ball after a fresh countdown", () => {
    const engine = playing();
    advance(engine, 0.2);
    const ball = { ...engine.state.ball };
    engine.pause("hidden");
    advance(engine, 1);
    expect(engine.state.ball).toEqual(ball);
    engine.resume();
    advance(engine, 3);
    expect(engine.state.phase).toBe("playing");
    expect(engine.state.ball).toEqual(ball);
    engine.update(1 / 60);
    expect(engine.state.ball.x).not.toBe(ball.x);
  });

  it("keeps keyboard and pointer controls inside the arena", () => {
    const engine = playing();
    engine.setHumanTarget(-1000);
    advance(engine, 0.5);
    expect(engine.state.paddles.human.y).toBe(GAME.humanPaddleHeight / 2);
    engine.setKeyboardDirection(1);
    advance(engine, 1);
    expect(engine.state.paddles.human.y).toBe(
      GAME.height - GAME.humanPaddleHeight / 2,
    );
  });
});

describe("intercept prediction", () => {
  it("unfolds one and many wall reflections, including negative coordinates", () => {
    expect(reflectY(700)).toBe(484);
    expect(reflectY(-100)).toBe(116);
    expect(reflectY(700 + 1168 * 4)).toBe(484);
    expect(reflectY(-100 - 1168 * 3)).toBe(116);
  });

  it("predicts wall bounce intercepts and reports unavailable away trajectories", () => {
    expect(predictIntercept({ x: 500, y: 550, vx: 400, vy: 200 }, 900)).toEqual(
      { interceptY: 434, timeToImpactMs: 1000 },
    );
    expect(
      predictIntercept({ x: 500, y: 550, vx: -400, vy: 200 }, 900).interceptY,
    ).toBeNull();
    expect(
      predictIntercept({ x: 500, y: 550, vx: 0, vy: 200 }, 900).interceptY,
    ).toBeNull();
  });
});

describe("bounded model actions", () => {
  it("executes a zero-confidence deterministic fallback and prohibits risky return styles or boost", () => {
    const engine = playing();
    towardAgent(engine);
    const fallback = createFallbackDecision(
      engine.createSnapshot(1),
      "provider_error",
    );
    const applied = engine.applyDecision({
      ...fallback,
      returnStyle: "FAST",
      returnStyleConfidence: 1,
      useBoostProbability: 1,
    });
    advance(engine, 0.1);
    expect(fallback.movementConfidence).toBe(0);
    expect(applied.movement).toBe("DOWN");
    expect(applied.returnStyle).toBe("SAFE");
    expect(applied.useBoost).toBe(false);
    expect(engine.state.paddles.ai.y).toBeGreaterThan(300);
  });

  it("does not secretly steer Jev before a decision", () => {
    const engine = playing();
    towardAgent(engine);
    advance(engine, 0.3);
    expect(engine.state.paddles.ai.y).toBe(300);
  });

  it("uses 70% speed for middling confidence and never boosts", () => {
    const engine = playing();
    towardAgent(engine);
    const action = engine.applyDecision(
      decision(engine, { movementConfidence: 0.5, useBoostProbability: 1 }),
    );
    advance(engine, 0.1);
    expect(action.useBoost).toBe(false);
    expect(engine.state.paddles.ai.y).toBeCloseTo(
      300 + engine.difficultyConfig.aiSpeed * 0.7 * 0.1,
      6,
    );
  });

  it("stops at the published intercept without choosing a new direction", () => {
    const engine = playing();
    towardAgent(engine);
    engine.state.ball.vy = 30;
    const target = engine.createSnapshot(1).prediction.interceptY!;
    engine.applyDecision(decision(engine));
    advance(engine, 0.4);
    expect(engine.state.movement).toBe("HOLD");
    expect(engine.state.paddles.ai.y).toBeLessThanOrEqual(target);
    expect(Math.abs(engine.state.paddles.ai.y - target)).toBeLessThan(12);
  });

  it("lets actions expire and rejects old sequences and reset-round decisions", () => {
    const engine = playing();
    Object.assign(engine.state.ball, { x: 800, y: 300, vx: -100, vy: 0 });
    const action = decision(engine, {
      returnStyle: "FAST",
      returnStyleConfidence: 1,
    });
    expect(engine.applyDecision(action).accepted).toBe(true);
    expect(engine.applyDecision(action).reason).toBe("stale");
    advance(engine, 1.3);
    expect(engine.state.movement).toBe("HOLD");
    expect(engine.state.returnStyle).toBe("SAFE");
    engine.state.roundId++;
    expect(engine.applyDecision({ ...action, sequence: 2 }).accepted).toBe(
      false,
    );
  });

  it("consumes FAST once on the next agent collision and gates weak return confidence", () => {
    const engine = playing();
    Object.assign(engine.state.ball, {
      x: 900,
      y: 300,
      vx: 330,
      vy: 0,
      speed: 330,
    });
    engine.applyDecision(
      decision(engine, {
        movement: "HOLD",
        returnStyle: "FAST",
        returnStyleConfidence: 1,
      }),
    );
    engine.update(0.05);
    expect(engine.state.ball.speed).toBe(378);
    expect(engine.state.ball.vx).toBeLessThan(0);
    expect(engine.state.returnStyle).toBe("SAFE");
    expect(
      engine.applyDecision(
        decision(engine, {
          sequence: 2,
          returnStyle: "FAST",
          returnStyleConfidence: 0.29,
        }),
      ).returnStyle,
    ).toBe("SAFE");
  });

  it("gates agent boost by probability, confidence, urgency and cooldown", () => {
    const engine = playing();
    Object.assign(engine.state.ball, {
      x: 800,
      y: 480,
      vx: 330,
      vy: 0,
      speed: 330,
    });
    expect(
      engine.applyDecision(decision(engine, { useBoostProbability: 0.64 }))
        .useBoost,
    ).toBe(false);
    expect(
      engine.applyDecision(
        decision(engine, { sequence: 2, useBoostProbability: 0.9 }),
      ).useBoost,
    ).toBe(true);
    expect(
      engine.applyDecision(
        decision(engine, { sequence: 3, useBoostProbability: 0.9 }),
      ).useBoost,
    ).toBe(false);
  });
});

describe("difficulty levels", () => {
  it("publishes valid capabilities and wider reachable bounds at higher levels", () => {
    const snapshots = ([1, 2, 3] as const).map((level) => {
      const engine = playing(level);
      Object.assign(engine.state.ball, {
        x: 800,
        y: 300,
        vx: 330,
        vy: 0,
        speed: 330,
      });
      const snapshot = engine.createSnapshot(1, 100);
      expect(agentGameStateSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.difficulty).toBe(level);
      expect(snapshot.humanPaddle).toMatchObject({
        height: GAME.humanPaddleHeight,
        maxSpeed: GAME.humanSpeed,
      });
      expect(snapshot.capabilities).toMatchObject({
        movementSpeed: engine.difficultyConfig.aiSpeed,
        boostSpeed: engine.difficultyConfig.aiBoostSpeed,
        boostDurationMs: GAME.boostDuration * 1000,
        boostCooldownMs: GAME.boostCooldown * 1000,
        boostCooldownRemainingMs: 0,
        shotPlacementEnabled: level !== 1,
        maxBallSpeed: GAME.maxBallSpeed,
      });
      expect(snapshot.prediction.boostReachableMinY).toBeLessThanOrEqual(
        snapshot.prediction.reachableMinY,
      );
      expect(snapshot.prediction.boostReachableMaxY).toBeGreaterThanOrEqual(
        snapshot.prediction.reachableMaxY,
      );
      return snapshot;
    });
    const widths = snapshots.map(
      (snapshot) =>
        snapshot.prediction.reachableMaxY - snapshot.prediction.reachableMinY,
    );
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(widths[2]).toBeGreaterThan(widths[1]);
  });

  it("defaults to level 1 and keeps the selected level when restarting", () => {
    const engine = new PongEngine();
    expect(engine.state.difficulty).toBe(1);
    engine.setDifficulty(2);
    expect(engine.state.difficulty).toBe(2);
    expect(engine.state.phase).toBe("ready");
    engine.start();
    const previousMatch = engine.state.matchId;
    engine.restart();
    expect(engine.state.difficulty).toBe(2);
    expect(engine.state.phase).toBe("countdown");
    expect(engine.state.matchId).not.toBe(previousMatch);
  });

  it("does not promise a boost that is still cooling down when the decision arrives", () => {
    const engine = playing(3);
    towardAgent(engine);
    engine.state.ball.x = 800;
    engine.state.paddles.ai.boostReadyAt = engine.state.elapsed + 0.3;
    const snapshot = engine.createSnapshot(1, 90);
    expect(snapshot.capabilities.boostCooldownRemainingMs).toBeCloseTo(300);
    expect(snapshot.prediction.boostReachableMinY).toBe(
      snapshot.prediction.reachableMinY,
    );
    expect(snapshot.prediction.boostReachableMaxY).toBe(
      snapshot.prediction.reachableMaxY,
    );

    engine.state.paddles.ai.boostUntil = engine.state.elapsed + 0.2;
    const activeBoost = engine.createSnapshot(2, 90);
    expect(activeBoost.prediction.boostReachableMinY).toBeLessThan(
      activeBoost.prediction.reachableMinY,
    );
    expect(activeBoost.prediction.boostReachableMaxY).toBeGreaterThan(
      activeBoost.prediction.reachableMaxY,
    );
  });

  it("starts a fresh match when difficulty changes and rejects the previous match's action", () => {
    const engine = playing(3);
    towardAgent(engine);
    const previous = decision(engine);
    const previousMatch = engine.state.matchId;
    engine.state.score.human = 3;
    engine.setDifficulty(1);
    expect(engine.state.matchId).not.toBe(previousMatch);
    expect(engine.state.difficulty).toBe(1);
    expect(engine.state.phase).toBe("ready");
    expect(engine.state.score).toEqual({ human: 0, ai: 0 });
    engine.start();
    advance(engine, 3);
    expect(engine.applyDecision(previous)).toMatchObject({
      accepted: false,
      reason: "stale",
    });
  });

  it("gives each higher level greater movement and recovery for the same decision", () => {
    const incoming: number[] = [];
    const recovery: number[] = [];
    for (const level of [1, 2, 3] as const) {
      const engine = playing(level);
      Object.assign(engine.state.ball, {
        x: 300,
        y: 550,
        vx: 100,
        vy: 0,
        speed: 100,
      });
      engine.applyDecision(decision(engine));
      advance(engine, 0.2);
      incoming.push(engine.state.paddles.ai.y - 300);

      const away = playing(level);
      away.state.paddles.ai.y = 60;
      Object.assign(away.state.ball, {
        x: 700,
        y: 300,
        vx: -100,
        vy: 0,
        speed: 100,
      });
      away.applyDecision(decision(away));
      advance(away, 0.2);
      recovery.push(away.state.paddles.ai.y - 60);
    }
    expect(incoming[1]).toBeGreaterThan(incoming[0]);
    expect(incoming[2]).toBeGreaterThan(incoming[1]);
    expect(recovery[1]).toBeGreaterThan(recovery[0]);
    expect(recovery[2]).toBeGreaterThan(recovery[1]);
    expect(incoming[2]).toBeCloseTo(incoming[0] * 3, 6);
  });

  it("keeps a hard-mode move alive through a slow response gap, then expires it", () => {
    const engine = playing(3);
    engine.state.paddles.ai.y = 48;
    Object.assign(engine.state.ball, {
      x: 100,
      y: 552,
      vx: 50,
      vy: 0,
      speed: 50,
    });
    engine.applyDecision(decision(engine));
    advance(engine, 0.65);
    expect(engine.state.movement).toBe("DOWN");
    expect(engine.state.paddles.ai.y).toBeGreaterThan(300);
    advance(engine, 0.5);
    expect(engine.state.movement).toBe("HOLD");
    expect(engine.state.paddles.ai.y).toBeLessThan(540);
    const stopped = engine.state.paddles.ai.y;
    advance(engine, 0.2);
    expect(engine.state.paddles.ai.y).toBe(stopped);
  });

  it("stops a long hard-mode action at its intercept instead of overshooting", () => {
    const engine = playing(3);
    Object.assign(engine.state.ball, {
      x: 300,
      y: 380,
      vx: 100,
      vy: 0,
      speed: 100,
    });
    engine.applyDecision(decision(engine));
    advance(engine, 0.7);
    expect(engine.state.movement).toBe("HOLD");
    expect(engine.state.paddles.ai.y).toBeGreaterThan(365);
    expect(engine.state.paddles.ai.y).toBeLessThanOrEqual(380);
  });

  it("extends hard-mode actions for measured latency but keeps a strict maximum", () => {
    const engine = playing(3);
    towardAgent(engine);
    const snapshot = engine.createSnapshot(1, 5_000);
    const applied = engine.applyDecision(
      decision(engine, {
        timing: { serverMs: 0, providerMs: null, roundTripMs: 5_000 },
      }),
    );
    expect(snapshot.capabilities.movementLeaseMs).toBe(1_600);
    expect(applied.movementExpiresAt - engine.state.elapsed).toBeCloseTo(1.6);
  });

  it("clears a long action when a paddle return changes the ball's direction", () => {
    const engine = playing(3);
    engine.state.paddles.ai.y = 150;
    Object.assign(engine.state.ball, {
      x: 60,
      y: 300,
      vx: -330,
      vy: 0,
      speed: 330,
    });
    const action = decision(engine);
    engine.applyDecision(action);
    const previousDirection = engine.state.directionVersion;
    advance(engine, 0.05);
    expect(engine.state.directionVersion).toBeGreaterThan(previousDirection);
    expect(engine.state.movement).toBe("HOLD");
    expect(engine.applyDecision({ ...action, sequence: 2 }).reason).toBe(
      "stale",
    );
  });

  it.each(
    ([2, 3] as const).flatMap((level) =>
      (["FAST", "ANGLED"] as const).flatMap((returnStyle) =>
        (["UPPER", "LOWER"] as const).map((shotTarget) => ({
          level,
          returnStyle,
          shotTarget,
        })),
      ),
    ),
  )(
    "lands level $level $returnStyle shots at $shotTarget within the physics limits",
    ({ level, returnStyle, shotTarget }) => {
      const engine = playing(level);
      Object.assign(engine.state.ball, {
        x: 900,
        y: 300,
        vx: GAME.maxBallSpeed,
        vy: 0,
        speed: GAME.maxBallSpeed,
      });
      const action = engine.applyDecision(
        decision(engine, {
          movement: "HOLD",
          returnStyle,
          returnStyleConfidence: 1,
          shotTarget,
          shotTargetConfidence: 0.95,
        }),
      );
      expect(action.shotTarget).toBe(shotTarget);
      advance(engine, 0.05);
      expect(engine.state.ball.vx).toBeLessThan(0);
      expect(engine.state.ball.speed).toBeLessThanOrEqual(GAME.maxBallSpeed);
      const intercept = predictIntercept(
        engine.state.ball,
        GAME.humanX + GAME.paddleWidth / 2 + GAME.ballRadius,
      ).interceptY!;
      expect(intercept).toBeCloseTo(shotTarget === "UPPER" ? 60 : 540, 5);
      expect(
        Math.abs(Math.atan2(engine.state.ball.vy, -engine.state.ball.vx)),
      ).toBeLessThanOrEqual(level === 2 ? 0.9 : 1.04);
      expect(engine.state.shotTarget).toBeNull();
    },
  );

  it("never gives a fallback or easy-level action aimed returns", () => {
    for (const [level, source] of [
      [1, "mock"],
      [3, "fallback"],
    ] as const) {
      const engine = playing(level);
      towardAgent(engine);
      const applied = engine.applyDecision(
        decision(engine, {
          source,
          shotTarget: "LOWER",
          shotTargetConfidence: 1,
        }),
      );
      expect(applied.shotTarget).toBeNull();
      expect(engine.state.shotTarget).toBeNull();
    }
  });
});
