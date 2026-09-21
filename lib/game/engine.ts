import type {
  AgentDecision,
  AgentGameState,
  DecisionSource,
  Movement,
  ReturnStyle,
  Strategy,
} from "../agent/contracts";
import { ACTION_POLICY, clamp, GAME } from "./constants";
import { predictIntercept } from "./prediction";

export type GamePhase =
  "ready" | "countdown" | "playing" | "paused" | "finished";
export type Side = "human" | "ai";

export interface Paddle {
  x: number;
  y: number;
  height: number;
  velocity: number;
  boostUntil: number;
  boostReadyAt: number;
}

export interface GameState {
  width: number;
  height: number;
  ball: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    speed: number;
    radius: number;
  };
  paddles: { human: Paddle; ai: Paddle };
  score: { human: number; ai: number };
  phase: GamePhase;
  countdown: number;
  rally: number;
  longestRally: number;
  winner: Side | null;
  matchId: string;
  roundId: number;
  directionVersion: number;
  elapsed: number;
  movement: Movement;
  movementSpeedScale: number;
  returnStyle: ReturnStyle;
  decisionSource: DecisionSource | null;
  pauseReason: "manual" | "hidden" | null;
  hits: { human: number; ai: number };
}

export interface GameEvent {
  type: "countdown" | "serve" | "wall" | "hit" | "score" | "boost" | "finish";
  x: number;
  y: number;
  side?: Side;
  style?: ReturnStyle;
  value?: number;
}

export interface AppliedDecision {
  accepted: boolean;
  movement: Movement;
  returnStyle: ReturnStyle;
  useBoost: boolean;
  source: DecisionSource;
  reason?: string;
  movementExpiresAt: number;
  returnExpiresAt: number;
}

let nextMatchId = 1;

/** Fixed-step simulation. The model owns Jev's direction; this class enforces physics and action limits. */
export class PongEngine {
  readonly state: GameState;
  private accumulator = 0;
  private events: GameEvent[] = [];
  private humanTarget: number | null = null;
  private keyboardDirection: -1 | 0 | 1 = 0;
  private movementExpiresAt = 0;
  private returnExpiresAt = 0;
  private movementStopY: number | null = null;
  private pendingServe = true;
  private lastSequence = -1;

  constructor() {
    this.state = this.initialState();
  }

  private initialState(): GameState {
    return {
      width: GAME.width,
      height: GAME.height,
      ball: {
        x: GAME.width / 2,
        y: GAME.height / 2,
        vx: 0,
        vy: 0,
        speed: GAME.initialBallSpeed,
        radius: GAME.ballRadius,
      },
      paddles: {
        human: {
          x: GAME.humanX,
          y: GAME.height / 2,
          height: GAME.humanPaddleHeight,
          velocity: 0,
          boostUntil: 0,
          boostReadyAt: 0,
        },
        ai: {
          x: GAME.aiX,
          y: GAME.height / 2,
          height: GAME.aiPaddleHeight,
          velocity: 0,
          boostUntil: 0,
          boostReadyAt: 0,
        },
      },
      score: { human: 0, ai: 0 },
      phase: "ready",
      countdown: GAME.countdownSeconds,
      rally: 0,
      longestRally: 0,
      winner: null,
      matchId: `match-${Date.now().toString(36)}-${nextMatchId++}`,
      roundId: 1,
      directionVersion: 0,
      elapsed: 0,
      movement: "HOLD",
      movementSpeedScale: 1,
      returnStyle: "SAFE",
      decisionSource: null,
      pauseReason: null,
      hits: { human: 0, ai: 0 },
    };
  }

  start(): void {
    if (this.state.phase !== "ready") return;
    this.beginCountdown(true);
  }

  restart(): void {
    Object.assign(this.state, this.initialState());
    this.accumulator = 0;
    this.events = [];
    this.humanTarget = null;
    this.keyboardDirection = 0;
    this.lastSequence = -1;
    this.clearAgentAction();
    this.beginCountdown(true);
  }

  pause(reason: "manual" | "hidden" = "manual"): void {
    if (this.state.phase !== "playing" && this.state.phase !== "countdown")
      return;
    this.state.phase = "paused";
    this.state.pauseReason = reason;
    this.state.paddles.human.velocity = 0;
    this.state.paddles.ai.velocity = 0;
    this.keyboardDirection = 0;
    this.accumulator = 0;
    this.clearAgentAction();
  }

  resume(): void {
    if (this.state.phase !== "paused") return;
    this.state.pauseReason = null;
    this.beginCountdown(this.pendingServe);
  }

  setHumanTarget(y: number | null): void {
    this.humanTarget = y !== null && Number.isFinite(y) ? y : null;
  }

  setKeyboardDirection(direction: -1 | 0 | 1): void {
    this.keyboardDirection = direction;
    if (direction !== 0) this.humanTarget = null;
  }

  consumeEvents(): GameEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  update(dtSeconds: number): void {
    if (
      !Number.isFinite(dtSeconds) ||
      dtSeconds <= 0 ||
      this.state.phase === "paused" ||
      this.state.phase === "ready" ||
      this.state.phase === "finished"
    )
      return;
    this.accumulator += Math.min(dtSeconds, 0.25);
    while (this.accumulator + 1e-10 >= GAME.fixedStep) {
      this.accumulator -= GAME.fixedStep;
      this.step(GAME.fixedStep);
    }
  }

  applyDecision(decision: AgentDecision): AppliedDecision {
    const s = this.state;
    const result: AppliedDecision = {
      accepted: false,
      movement: s.movement,
      returnStyle: s.returnStyle,
      useBoost: false,
      source: decision.source,
      movementExpiresAt: this.movementExpiresAt,
      returnExpiresAt: this.returnExpiresAt,
    };
    if (
      decision.matchId !== s.matchId ||
      decision.roundId !== s.roundId ||
      decision.directionVersion !== s.directionVersion ||
      decision.sequence <= this.lastSequence
    ) {
      return { ...result, reason: "stale" };
    }
    if (s.phase !== "playing") return { ...result, reason: "not-playing" };
    this.lastSequence = decision.sequence;
    const isFallback = decision.source === "fallback";
    // A fallback is an explicit deterministic action, not a model-confidence
    // estimate. Its zero confidence must not prevent the safety action running.
    let movement =
      isFallback ||
      decision.movementConfidence >= ACTION_POLICY.minimumMovementConfidence
        ? decision.movement
        : "HOLD";
    const returnStyle =
      !isFallback &&
      decision.returnStyleConfidence >= ACTION_POLICY.minimumReturnConfidence
        ? decision.returnStyle
        : "SAFE";
    const prediction = predictIntercept(s.ball);
    this.movementStopY =
      prediction.interceptY === null
        ? GAME.height / 2
        : clamp(
            prediction.interceptY,
            s.paddles.ai.height / 2,
            GAME.height - s.paddles.ai.height / 2,
          );
    // A model action is a bounded move towards its current intercept. Stop at the
    // target without ever selecting the opposite direction on the model's behalf.
    if (this.movementStopY !== null) {
      const delta = this.movementStopY - s.paddles.ai.y;
      if (
        (movement === "UP" && delta >= -12) ||
        (movement === "DOWN" && delta <= 12)
      )
        movement = "HOLD";
    }
    s.movement = movement;
    s.movementSpeedScale =
      isFallback ||
      decision.movementConfidence >= ACTION_POLICY.fullMovementConfidence
        ? 1
        : ACTION_POLICY.cautiousSpeedScale;
    if (s.ball.vx <= 0) s.movementSpeedScale *= GAME.aiRecenterSpeedScale;
    s.returnStyle = returnStyle;
    s.decisionSource = decision.source;
    this.movementExpiresAt = s.elapsed + GAME.movementLease;
    this.returnExpiresAt = s.elapsed + GAME.returnLease;
    const ai = s.paddles.ai;
    const distance =
      this.movementStopY === null ? 0 : Math.abs(this.movementStopY - ai.y);
    const seconds = (prediction.timeToImpactMs ?? Infinity) / 1000;
    const urgent =
      s.ball.vx > 0 &&
      seconds < 0.65 &&
      distance > GAME.aiSpeed * seconds * 0.75 &&
      distance > ai.height * 0.35;
    const useBoost =
      decision.source !== "fallback" &&
      decision.movementConfidence >= ACTION_POLICY.fullMovementConfidence &&
      decision.useBoostProbability >= ACTION_POLICY.boostProbability &&
      movement !== "HOLD" &&
      urgent &&
      s.elapsed >= ai.boostReadyAt;
    if (useBoost) this.boost("ai");
    return {
      accepted: true,
      movement,
      returnStyle,
      useBoost,
      source: decision.source,
      ...(!isFallback &&
      decision.movementConfidence < ACTION_POLICY.minimumMovementConfidence
        ? { reason: "low-confidence-hold" }
        : {}),
      movementExpiresAt: this.movementExpiresAt,
      returnExpiresAt: this.returnExpiresAt,
    };
  }

  createSnapshot(
    sequence: number,
    latencyMs: number | null = null,
    strategy: Strategy = "balanced",
  ): AgentGameState {
    const s = this.state;
    const prediction =
      s.ball.vx > 0
        ? predictIntercept(s.ball)
        : { interceptY: null, timeToImpactMs: null };
    return {
      sequence,
      capturedAtMs: Math.round(s.elapsed * 1000),
      matchId: s.matchId,
      roundId: s.roundId,
      directionVersion: s.directionVersion,
      arena: { width: GAME.width, height: GAME.height },
      ball: {
        x: s.ball.x,
        y: s.ball.y,
        velocityX: s.ball.vx,
        velocityY: s.ball.vy,
        speed: s.ball.speed,
        movingTowardAgent: s.ball.vx > 0,
      },
      agentPaddle: {
        centerY: s.paddles.ai.y,
        velocityY: s.paddles.ai.velocity,
        height: s.paddles.ai.height,
        boostReady: s.elapsed >= s.paddles.ai.boostReadyAt,
      },
      humanPaddle: {
        centerY: s.paddles.human.y,
        velocityY: s.paddles.human.velocity,
      },
      prediction: {
        ...prediction,
        uncertaintyPx:
          prediction.interceptY === null
            ? 0
            : Math.min(
                120,
                10 + ((Math.abs(s.ball.vy) * (latencyMs ?? 0)) / 1000) * 0.2,
              ),
      },
      match: {
        humanScore: s.score.human,
        agentScore: s.score.ai,
        rallyLength: s.rally,
      },
      agent: {
        strategy,
        previousMovement: s.movement,
        previousReturnStyle: s.returnStyle,
        smoothedLatencyMs: latencyMs,
      },
    };
  }

  private beginCountdown(serve: boolean): void {
    this.state.phase = "countdown";
    this.state.countdown = GAME.countdownSeconds;
    this.pendingServe = serve;
    this.events.push({
      type: "countdown",
      x: GAME.width / 2,
      y: GAME.height / 2,
      value: 3,
    });
  }

  private clearAgentAction(): void {
    this.state.movement = "HOLD";
    this.state.movementSpeedScale = 1;
    this.state.returnStyle = "SAFE";
    this.state.decisionSource = null;
    this.movementStopY = null;
    this.movementExpiresAt = 0;
    this.returnExpiresAt = 0;
  }

  private step(dt: number): void {
    const s = this.state;
    if (s.phase !== "playing" && s.phase !== "countdown") return;
    s.elapsed += dt;
    this.moveHuman(dt);
    if (s.phase === "countdown") {
      const previous = Math.ceil(s.countdown);
      s.countdown = Math.max(0, s.countdown - dt);
      if (Math.ceil(s.countdown) !== previous && s.countdown > 0.001)
        this.events.push({
          type: "countdown",
          x: GAME.width / 2,
          y: GAME.height / 2,
          value: Math.ceil(s.countdown),
        });
      if (s.countdown <= 1e-8) {
        s.countdown = 0;
        s.phase = "playing";
        if (this.pendingServe) this.serve();
        this.pendingServe = false;
      }
      return;
    }
    this.moveAI(dt);
    this.moveBall(dt);
  }

  private moveHuman(dt: number): void {
    const p = this.state.paddles.human;
    const oldY = p.y;
    const target =
      this.humanTarget === null
        ? p.y + this.keyboardDirection * GAME.humanSpeed * dt
        : clamp(this.humanTarget, p.height / 2, GAME.height - p.height / 2);
    const speed =
      this.state.elapsed < p.boostUntil
        ? GAME.humanBoostSpeed
        : GAME.humanSpeed;
    const keyboardTarget =
      this.humanTarget === null
        ? p.y + this.keyboardDirection * speed * dt
        : target;
    p.y = clamp(
      p.y + clamp(keyboardTarget - p.y, -speed * dt, speed * dt),
      p.height / 2,
      GAME.height - p.height / 2,
    );
    p.velocity = (p.y - oldY) / dt;
  }

  private moveAI(dt: number): void {
    const s = this.state;
    const p = s.paddles.ai;
    const oldY = p.y;
    if (s.elapsed >= this.movementExpiresAt) s.movement = "HOLD";
    if (s.elapsed >= this.returnExpiresAt) s.returnStyle = "SAFE";
    const direction = s.movement === "UP" ? -1 : s.movement === "DOWN" ? 1 : 0;
    const speed =
      (s.elapsed < p.boostUntil ? GAME.aiBoostSpeed : GAME.aiSpeed) *
      s.movementSpeedScale;
    let next = p.y + direction * speed * dt;
    if (this.movementStopY !== null && direction !== 0) {
      const target = this.movementStopY;
      if (
        (direction < 0 && next <= target + 10) ||
        (direction > 0 && next >= target - 10)
      ) {
        next = p.y + clamp(target - p.y, -speed * dt, speed * dt);
        s.movement = "HOLD";
      }
    }
    p.y = clamp(next, p.height / 2, GAME.height - p.height / 2);
    p.velocity = (p.y - oldY) / dt;
  }

  private boost(side: Side): void {
    const p = this.state.paddles[side];
    p.boostUntil = this.state.elapsed + GAME.boostDuration;
    p.boostReadyAt = this.state.elapsed + GAME.boostCooldown;
    this.events.push({ type: "boost", side, x: p.x, y: p.y });
  }

  private serve(): void {
    const s = this.state;
    const direction = s.roundId % 2 === 1 ? -1 : 1;
    const angle = [0.16, -0.22, 0.28, -0.14][(s.roundId - 1) % 4];
    Object.assign(s.ball, {
      x: GAME.width / 2,
      y: GAME.height / 2,
      speed: GAME.initialBallSpeed,
      vx: Math.cos(angle) * GAME.initialBallSpeed * direction,
      vy: Math.sin(angle) * GAME.initialBallSpeed,
    });
    s.directionVersion++;
    this.clearAgentAction();
    this.events.push({ type: "serve", x: s.ball.x, y: s.ball.y });
  }

  private moveBall(dt: number): void {
    const s = this.state;
    const b = s.ball;
    const oldX = b.x;
    const oldY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y < b.radius || b.y > GAME.height - b.radius) {
      b.y =
        b.y < b.radius
          ? b.radius * 2 - b.y
          : (GAME.height - b.radius) * 2 - b.y;
      b.vy *= -1;
      // A wall bounce is already included in the published intercept prediction.
      // Horizontal direction changes invalidate decisions; vertical reflections do not.
      this.events.push({ type: "wall", x: b.x, y: b.y });
    }
    const side: Side = b.vx < 0 ? "human" : "ai";
    const p = s.paddles[side];
    const face =
      p.x + (side === "human" ? 1 : -1) * (GAME.paddleWidth / 2 + b.radius);
    const crossed =
      side === "human"
        ? oldX >= face && b.x <= face
        : oldX <= face && b.x >= face;
    if (crossed) {
      const fraction = (face - oldX) / (b.x - oldX);
      const hitY = oldY + (b.y - oldY) * fraction;
      if (Math.abs(hitY - p.y) <= p.height / 2 + b.radius) {
        b.x = face;
        b.y = clamp(hitY, b.radius, GAME.height - b.radius);
        this.hitPaddle(side);
        // Finish the fraction of this step after impact without tunnelling.
        b.x += b.vx * dt * (1 - fraction);
        b.y = clamp(
          b.y + b.vy * dt * (1 - fraction),
          b.radius,
          GAME.height - b.radius,
        );
      }
    }
    if (b.x < -b.radius) this.scorePoint("ai");
    else if (b.x > GAME.width + b.radius) this.scorePoint("human");
  }

  private hitPaddle(side: Side): void {
    const s = this.state;
    const p = s.paddles[side];
    const b = s.ball;
    const style =
      side === "ai" && s.elapsed < this.returnExpiresAt
        ? s.returnStyle
        : "SAFE";
    const offset = clamp((b.y - p.y) / (p.height / 2), -1, 1);
    const humanEdgeBoost =
      side === "human" &&
      Math.abs(offset) >= 0.65 &&
      s.elapsed >= p.boostReadyAt;
    if (humanEdgeBoost) this.boost("human");
    const motion = clamp(
      p.velocity / (side === "human" ? GAME.humanSpeed : GAME.aiSpeed),
      -1,
      1,
    );
    const angleScale =
      side === "human"
        ? 0.94
        : style === "ANGLED"
          ? 1.06
          : style === "FAST"
            ? 0.58
            : 0.72;
    const offsetWithAngle =
      style === "ANGLED" && Math.abs(offset) < 0.3
        ? offset < 0
          ? -0.55
          : 0.55
        : offset;
    const angle = clamp(
      offsetWithAngle * angleScale + motion * 0.08,
      -1.04,
      1.04,
    );
    b.speed = Math.min(
      GAME.maxBallSpeed,
      b.speed +
        (humanEdgeBoost ? 38 : style === "FAST" ? 48 : GAME.ballAcceleration),
    );
    b.vx = Math.cos(angle) * b.speed * (side === "human" ? 1 : -1);
    b.vy = Math.sin(angle) * b.speed;
    s.rally++;
    s.hits[side]++;
    s.longestRally = Math.max(s.longestRally, s.rally);
    s.directionVersion++;
    this.clearAgentAction();
    this.events.push({
      type: "hit",
      side,
      style,
      x: b.x,
      y: b.y,
      value: s.rally,
    });
  }

  private scorePoint(side: Side): void {
    const s = this.state;
    s.score[side]++;
    s.directionVersion++;
    this.events.push({
      type: "score",
      side,
      x: s.ball.x,
      y: s.ball.y,
      value: s.score[side],
    });
    s.rally = 0;
    this.clearAgentAction();
    s.paddles.ai.velocity = 0;
    s.ball.vx = 0;
    s.ball.vy = 0;
    if (s.score[side] >= GAME.winningScore) {
      s.phase = "finished";
      s.winner = side;
      this.events.push({
        type: "finish",
        side,
        x: GAME.width / 2,
        y: GAME.height / 2,
      });
      return;
    }
    s.roundId++;
    s.ball.x = GAME.width / 2;
    s.ball.y = GAME.height / 2;
    s.ball.speed = GAME.initialBallSpeed;
    s.paddles.ai.y = GAME.height / 2;
    this.beginCountdown(true);
  }
}
