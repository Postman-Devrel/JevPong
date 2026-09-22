import type {
  AgentDecision,
  AgentDecisionResponse,
  AgentGameState,
  FallbackReason,
  Movement,
  Strategy,
} from "./contracts";
import { ACTION_POLICY } from "../game/constants";
import { PongEngine, type AppliedDecision } from "../game/engine";

export interface ControllerOptions {
  requestDecision: (
    snapshot: AgentGameState,
    signal: AbortSignal,
  ) => Promise<AgentDecisionResponse>;
  intervalMs?: number;
  awayIntervalMs?: number;
  timeoutMs?: number;
  /** Monotonic response-receipt clock; separate from animation scheduling. */
  now?: () => number;
  onDecision?: (
    decision: AgentDecision,
    snapshot: AgentGameState,
    applied: AppliedDecision,
    rawResponse: unknown,
  ) => void;
  onStale?: (decision: AgentDecision, snapshot: AgentGameState) => void;
}

export interface ControllerTelemetry {
  lastDecision: AgentDecision | null;
  lastApplied: AppliedDecision | null;
  lastRawResponse: unknown;
  decisionCount: number;
  rejectedCount: number;
  fallbackCount: number;
  smoothedLatencyMs: number | null;
  inFlight: boolean;
  lastError: string | null;
  suspendedReason: string | null;
}

interface PendingRequest {
  snapshot: AgentGameState;
  controller: AbortController;
  startedAt: number;
  sentAt: number;
  generation: number;
}

function probability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Runtime validation also protects the canvas loop from malformed API responses. */
function validDecision(value: unknown): value is AgentDecision {
  if (!value || typeof value !== "object") return false;
  const d = value as AgentDecision;
  return (
    Number.isInteger(d.sequence) &&
    typeof d.matchId === "string" &&
    Number.isInteger(d.roundId) &&
    Number.isInteger(d.directionVersion) &&
    typeof d.requestId === "string" &&
    ["UP", "DOWN", "HOLD"].includes(d.movement) &&
    ["SAFE", "ANGLED", "FAST"].includes(d.returnStyle) &&
    ["jev", "mock", "fallback"].includes(d.source) &&
    probability(d.movementConfidence) &&
    probability(d.returnStyleConfidence) &&
    probability(d.useBoostProbability) &&
    ((d.shotTarget === undefined &&
      d.shotTargetConfidence === undefined &&
      d.shotTargetProbabilities === undefined) ||
      (typeof d.shotTarget === "string" &&
        ["UPPER", "CENTER", "LOWER"].includes(d.shotTarget) &&
        probability(d.shotTargetConfidence) &&
        !!d.shotTargetProbabilities &&
        ["UPPER", "CENTER", "LOWER"].every((key) =>
          probability(
            d.shotTargetProbabilities![
              key as keyof typeof d.shotTargetProbabilities
            ],
          ),
        ))) &&
    !!d.movementProbabilities &&
    ["UP", "DOWN", "HOLD"].every((key) =>
      probability(d.movementProbabilities[key as Movement]),
    ) &&
    !!d.returnStyleProbabilities &&
    ["SAFE", "ANGLED", "FAST"].every((key) =>
      probability(
        d.returnStyleProbabilities[
          key as keyof typeof d.returnStyleProbabilities
        ],
      ),
    ) &&
    !!d.usage &&
    Number.isFinite(d.usage.inputTokens) &&
    Number.isFinite(d.usage.outputTokens) &&
    !!d.timing &&
    Number.isFinite(d.timing.serverMs)
  );
}

export function createFallbackDecision(
  snapshot: AgentGameState,
  reason: FallbackReason,
  requestId = `local-${snapshot.sequence}`,
): AgentDecision {
  const target =
    snapshot.ball.movingTowardAgent && snapshot.prediction.interceptY !== null
      ? snapshot.prediction.interceptY
      : snapshot.arena.height / 2;
  const delta = target - snapshot.agentPaddle.centerY;
  const movement: Movement =
    Math.abs(delta) <= 18 ? "HOLD" : delta < 0 ? "UP" : "DOWN";
  return {
    sequence: snapshot.sequence,
    matchId: snapshot.matchId,
    roundId: snapshot.roundId,
    directionVersion: snapshot.directionVersion,
    requestId,
    movement,
    movementProbabilities: {
      UP: movement === "UP" ? 1 : 0,
      DOWN: movement === "DOWN" ? 1 : 0,
      HOLD: movement === "HOLD" ? 1 : 0,
    },
    movementConfidence: 0,
    returnStyle: "SAFE",
    returnStyleProbabilities: { SAFE: 1, ANGLED: 0, FAST: 0 },
    returnStyleConfidence: 0,
    shotTarget: "CENTER",
    shotTargetProbabilities: { UPPER: 0, CENTER: 1, LOWER: 0 },
    shotTargetConfidence: 0,
    useBoostProbability: 0,
    model: "deterministic-fallback",
    usage: { inputTokens: 0, outputTokens: 0, billable: false },
    timing: { serverMs: 0, providerMs: null, roundTripMs: null },
    source: "fallback",
    fallbackReason: reason,
  };
}

/** One asynchronous request at a time; update never waits on the network. */
export class DecisionController {
  strategy: Strategy = "balanced";
  readonly telemetry: ControllerTelemetry = {
    lastDecision: null,
    lastApplied: null,
    lastRawResponse: null,
    decisionCount: 0,
    rejectedCount: 0,
    fallbackCount: 0,
    smoothedLatencyMs: null,
    inFlight: false,
    lastError: null,
    suspendedReason: null,
  };
  private sequence = 0;
  private lastAppliedSequence = -1;
  private generation = 0;
  private pending: PendingRequest | null = null;
  private nextRequestAt = 0;
  private retryAfterUntil = 0;
  private observedStateKey: string | null = null;
  private nextFallbackAt = 0;
  private nowMs = 0;
  private disposed = false;
  private fallbackReason: FallbackReason | null = null;
  private intervalMs: number;
  private awayIntervalMs: number | null;
  private timeoutMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly engine: PongEngine,
    private readonly options: ControllerOptions,
  ) {
    this.clock = options.now ?? (() => performance.now());
    this.intervalMs = Math.max(
      100,
      options.intervalMs ?? ACTION_POLICY.decisionIntervalMs,
    );
    this.awayIntervalMs =
      options.awayIntervalMs === undefined
        ? null
        : Math.max(this.intervalMs, options.awayIntervalMs);
    this.timeoutMs = Math.max(
      100,
      options.timeoutMs ?? ACTION_POLICY.timeoutMs,
    );
  }

  configure(
    options: Pick<
      ControllerOptions,
      "intervalMs" | "awayIntervalMs" | "timeoutMs"
    >,
  ): void {
    if (options.intervalMs !== undefined && Number.isFinite(options.intervalMs))
      this.intervalMs = Math.max(100, options.intervalMs);
    if (
      options.awayIntervalMs !== undefined &&
      Number.isFinite(options.awayIntervalMs)
    )
      this.awayIntervalMs = Math.max(this.intervalMs, options.awayIntervalMs);
    else if (this.awayIntervalMs !== null)
      this.awayIntervalMs = Math.max(this.intervalMs, this.awayIntervalMs);
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs))
      this.timeoutMs = Math.max(100, options.timeoutMs);
  }

  update(nowMs: number = performance.now()): void {
    if (this.disposed) return;
    this.nowMs = nowMs;
    if (this.engine.state.phase !== "playing") {
      this.cancelPending();
      this.observedStateKey = null;
      return;
    }
    const state = this.engine.state;
    const stateKey = `${state.matchId}:${state.roundId}:${state.directionVersion}`;
    if (stateKey !== this.observedStateKey) {
      this.observedStateKey = stateKey;
      this.cancelPending();
      // A serve, paddle contact, resumed play, or new round warrants a fresh
      // decision even if the preceding request already completed. Provider
      // Retry-After is tracked separately and remains authoritative.
      this.nextRequestAt = nowMs;
      this.nextFallbackAt = nowMs;
    }
    if (this.pending && !this.freshSnapshot(this.pending.snapshot)) {
      // A paddle hit or new round supersedes an action. Abort promptly, and still
      // validate the result if the underlying provider does not honour abort.
      this.cancelPending();
      this.nextRequestAt = nowMs;
    }
    if (this.pending && nowMs - this.pending.startedAt >= this.timeoutMs) {
      this.cancelPending();
      this.telemetry.lastError = "Jev timed out — fallback active";
      this.fallbackReason = "timeout";
      this.applyLocalFallback("timeout");
      this.nextRequestAt = nowMs + this.intervalMs;
    }
    // Hold the current bounded action while a newer model request is pending.
    // Issuing a newer local sequence here would make every slow recovery stale.
    if (this.fallbackReason && !this.pending && nowMs >= this.nextFallbackAt)
      this.applyLocalFallback(this.fallbackReason);
    if (
      !this.pending &&
      !this.telemetry.suspendedReason &&
      nowMs >= this.retryAfterUntil &&
      nowMs >= this.nextRequestAt
    )
      this.request(nowMs);
  }

  suspendRequests(reason: string): void {
    this.telemetry.suspendedReason = reason;
    this.telemetry.lastError = reason;
    this.fallbackReason = [
      "timeout",
      "rate_limit",
      "provider_error",
      "invalid_response",
      "missing_credentials",
      "authentication",
      "configuration",
      "offline",
      "low_confidence",
    ].includes(reason)
      ? (reason as FallbackReason)
      : "provider_error";
    this.cancelPending();
  }

  resumeRequests(): void {
    this.telemetry.suspendedReason = null;
    this.telemetry.lastError = null;
    this.fallbackReason = null;
    this.nextRequestAt = 0;
    this.retryAfterUntil = 0;
  }

  reset(): void {
    this.cancelPending();
    this.lastAppliedSequence = -1;
    this.nextRequestAt = 0;
    this.nextFallbackAt = 0;
    this.observedStateKey = null;
    if (!this.telemetry.suspendedReason) this.fallbackReason = null;
    Object.assign(this.telemetry, {
      lastDecision: null,
      lastApplied: null,
      lastRawResponse: null,
      decisionCount: 0,
      rejectedCount: 0,
      fallbackCount: 0,
      smoothedLatencyMs: null,
      inFlight: false,
      lastError: this.telemetry.suspendedReason,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }

  private cancelPending(): void {
    if (!this.pending) return;
    this.pending.controller.abort();
    this.pending = null;
    this.telemetry.inFlight = false;
    this.generation++;
  }

  private freshSnapshot(snapshot: AgentGameState): boolean {
    const state = this.engine.state;
    return (
      state.phase === "playing" &&
      snapshot.matchId === state.matchId &&
      snapshot.roundId === state.roundId &&
      snapshot.directionVersion === state.directionVersion
    );
  }

  private request(nowMs: number): void {
    const snapshot = this.engine.createSnapshot(
      ++this.sequence,
      this.telemetry.smoothedLatencyMs,
      this.strategy,
    );
    const controller = new AbortController();
    const request: PendingRequest = {
      snapshot,
      controller,
      startedAt: nowMs,
      sentAt: this.clock(),
      generation: this.generation,
    };
    this.pending = request;
    this.telemetry.inFlight = true;
    this.nextRequestAt =
      nowMs +
      (snapshot.ball.movingTowardAgent
        ? this.intervalMs
        : Math.max(
            this.intervalMs,
            this.awayIntervalMs ??
              this.engine.difficultyConfig.awayDecisionIntervalMs,
          ));
    // Promise.resolve also handles synchronous throws from custom transports.
    Promise.resolve()
      .then(() => this.options.requestDecision(snapshot, controller.signal))
      .then((response) => {
        if (this.disposed) return;
        const elapsed = Math.max(0, this.clock() - request.sentAt);
        if (
          request.generation !== this.generation ||
          this.pending !== request
        ) {
          if (validDecision(response?.decision))
            this.reject(
              {
                ...response.decision,
                timing: { ...response.decision.timing, roundTripMs: elapsed },
              },
              snapshot,
            );
          return;
        }
        this.pending = null;
        this.telemetry.inFlight = false;
        if (!validDecision(response?.decision)) {
          this.fallbackReason = "invalid_response";
          this.telemetry.lastError = "Invalid response — fallback active";
          this.applyLocalFallback("invalid_response", response?.rawResponse);
          this.nextRequestAt = this.nowMs + this.intervalMs;
          return;
        }
        const decision = {
          ...response.decision,
          timing: { ...response.decision.timing, roundTripMs: elapsed },
        };
        const idsMatchRequest =
          decision.sequence === snapshot.sequence &&
          decision.matchId === snapshot.matchId &&
          decision.roundId === snapshot.roundId &&
          decision.directionVersion === snapshot.directionVersion;
        if (
          !idsMatchRequest ||
          !this.freshSnapshot(snapshot) ||
          decision.sequence <= this.lastAppliedSequence
        ) {
          this.reject(decision, snapshot);
          this.nextRequestAt = this.nowMs;
          return;
        }
        this.telemetry.smoothedLatencyMs =
          this.telemetry.smoothedLatencyMs === null
            ? elapsed
            : this.telemetry.smoothedLatencyMs * 0.8 + elapsed * 0.2;
        this.retryAfterUntil = Math.max(
          this.retryAfterUntil,
          this.nowMs + Math.max(0, response.retryAfterMs ?? 0),
        );
        if (response.disabled)
          this.telemetry.suspendedReason =
            decision.fallbackReason ?? "provider unavailable";
        if (
          decision.movementConfidence <
            ACTION_POLICY.minimumMovementConfidence &&
          decision.source !== "fallback"
        ) {
          const fallback = createFallbackDecision(
            snapshot,
            "low_confidence",
            decision.requestId,
          );
          // Retain the observed model probabilities, usage, and confidence. The
          // action record distinguishes the executed fallback from the model vote.
          const applied = this.engine.applyDecision(fallback);
          this.record(
            {
              ...decision,
              usage: {
                ...decision.usage,
                billable: decision.usage.billable ?? decision.source === "jev",
              },
              source: "fallback",
              fallbackReason: "low_confidence",
            },
            snapshot,
            applied,
            response.rawResponse,
          );
          this.fallbackReason = "low_confidence";
          this.telemetry.lastError = "Low confidence — fallback active";
          this.nextFallbackAt = this.nowMs + this.intervalMs;
        } else {
          const applied = this.engine.applyDecision(decision);
          if (!applied.accepted) {
            this.reject(decision, snapshot);
            return;
          }
          this.record(decision, snapshot, applied, response.rawResponse);
          this.fallbackReason =
            decision.source === "fallback"
              ? (decision.fallbackReason ?? "provider_error")
              : null;
          this.telemetry.lastError =
            decision.source === "fallback"
              ? (decision.fallbackReason ?? "provider unavailable")
              : null;
          this.nextFallbackAt = this.nowMs + this.intervalMs;
        }
      })
      .catch((error) => {
        if (
          this.disposed ||
          request.generation !== this.generation ||
          this.pending !== request
        )
          return;
        this.pending = null;
        this.telemetry.inFlight = false;
        const failure = error as {
          name?: string;
          message?: string;
          retryAfterMs?: number;
          disabled?: boolean;
          fallbackReason?: FallbackReason;
        };
        const reason: FallbackReason =
          failure.fallbackReason ??
          (failure.name === "AbortError"
            ? "timeout"
            : typeof navigator !== "undefined" && !navigator.onLine
              ? "offline"
              : "provider_error");
        this.fallbackReason = reason;
        this.telemetry.lastError = `${reason.replaceAll("_", " ")} — fallback active`;
        if (failure.disabled)
          this.telemetry.suspendedReason = failure.message ?? reason;
        this.retryAfterUntil =
          this.nowMs + Math.max(this.intervalMs, failure.retryAfterMs ?? 0);
        this.applyLocalFallback(reason);
      });
  }

  private applyLocalFallback(
    reason: FallbackReason,
    rawResponse: unknown = null,
  ): void {
    if (this.engine.state.phase !== "playing") return;
    const snapshot = this.engine.createSnapshot(
      ++this.sequence,
      this.telemetry.smoothedLatencyMs,
      this.strategy,
    );
    const fallback = createFallbackDecision(snapshot, reason);
    const applied = this.engine.applyDecision(fallback);
    this.record(fallback, snapshot, applied, rawResponse);
    this.nextFallbackAt = this.nowMs + this.intervalMs;
  }

  private record(
    decision: AgentDecision,
    snapshot: AgentGameState,
    applied: AppliedDecision,
    rawResponse: unknown,
  ): void {
    if (!applied.accepted) {
      this.reject(decision, snapshot);
      return;
    }
    this.lastAppliedSequence = decision.sequence;
    this.telemetry.lastDecision = decision;
    this.telemetry.lastApplied = applied;
    this.telemetry.lastRawResponse = rawResponse;
    this.telemetry.decisionCount++;
    if (decision.source === "fallback") this.telemetry.fallbackCount++;
    this.options.onDecision?.(decision, snapshot, applied, rawResponse);
  }

  private reject(decision: AgentDecision, snapshot: AgentGameState): void {
    this.telemetry.rejectedCount++;
    this.options.onStale?.(decision, snapshot);
  }
}
