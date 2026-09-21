import { describe, expect, it } from "vitest";
import { PongEngine } from "../../lib/game/engine";
import { GAME } from "../../lib/game/constants";
import { predictIntercept, reflectY } from "../../lib/game/prediction";
import { createFallbackDecision } from "../../lib/agent/decision-controller";
import type { AgentDecision } from "../../lib/agent/contracts";

function advance(engine: PongEngine, seconds: number, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += step)
    engine.update(Math.min(step, seconds - elapsed));
}

function playing() {
  const engine = new PongEngine();
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
      300 + GAME.aiSpeed * 0.7 * 0.1,
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
