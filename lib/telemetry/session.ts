import type { AppliedDecision } from "../game/engine";
import type { AgentDecision, AgentGameState } from "../agent/contracts";
import { DEFAULT_PRICING, estimateCostUsd } from "../agent/cost";
import { redactSecrets } from "../agent/redact";

const HISTORY_LIMIT = 50;
const LATENCY_LIMIT = 100;
const RATE_WINDOW_MS = 5_000;
const RAW_LIMIT = 24_000;

type Pricing = { inputPerMillionUsd: number; outputPerMillionUsd: number };

export interface DecisionEvent {
  id: string;
  atMs: number;
  snapshot: AgentGameState;
  decision: AgentDecision;
  rawResponse: unknown;
  appliedAction?: AppliedDecision;
}

export interface SessionIncident {
  id: string;
  atMs: number;
  kind: "fallback" | "stale_discarded";
  sequence?: number;
  requestId?: string;
  reason?: AgentDecision["fallbackReason"];
}

export interface SessionMetrics {
  accepted: number;
  staleDiscarded: number;
  observedResponses: number;
  fallbackCount: number;
  fallbackRate: number;
  inputTokens: number;
  outputTokens: number;
  simulatedInputTokens: number;
  simulatedOutputTokens: number;
  estimatedCostUsd: number;
  decisionsPerSecond: number;
  rateWindowMs: number;
  latestLatencyMs: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencySamples: number;
}

export interface SessionOptions {
  appVersion?: string;
  pricing?: Pricing;
  /** Monotonic clock; injectable for deterministic tests. */
  now?: () => number;
}

export interface SessionExportConfig {
  match?: unknown;
  model?: unknown;
}

function count(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Bound provider output after redaction so unexpected upstream data stays small. */
function safeValue(value: unknown): unknown {
  const redacted = redactSecrets(value);
  const serialized = JSON.stringify(redacted);
  if (!serialized) return null;
  if (serialized.length > RAW_LIMIT) {
    return {
      truncated: true,
      originalCharacters: serialized.length,
      preview: serialized.slice(0, RAW_LIMIT),
    };
  }
  return JSON.parse(serialized) as unknown;
}

/** Browser-only session storage: survives match restarts, never persists to disk. */
export class SessionTelemetry {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private pricing: Pricing;
  private readonly appVersion: string;
  private readonly history: DecisionEvent[] = [];
  private readonly incidents: SessionIncident[] = [];
  private readonly latencies: number[] = [];
  private readonly acceptedAt: number[] = [];
  private nextId = 1;
  private accepted = 0;
  private staleDiscarded = 0;
  private observedResponses = 0;
  private fallbackCount = 0;
  private incidentCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private simulatedInputTokens = 0;
  private simulatedOutputTokens = 0;
  private estimatedCostUsd = 0;
  private latestLatencyMs: number | null = null;

  constructor(options: SessionOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.startedAtMs = this.now();
    this.pricing = { ...(options.pricing ?? DEFAULT_PRICING) };
    this.appVersion = options.appVersion ?? "1.0.0";
  }

  /** Applied before live requests are enabled; previously accrued cost stays fixed. */
  setPricing(pricing: Pricing): void {
    this.pricing = { ...pricing };
  }

  private elapsed(nowMs = this.now()): number {
    return Math.max(0, nowMs - this.startedAtMs);
  }

  private observe(decision: AgentDecision) {
    this.observedResponses += 1;
    const inputTokens = count(decision.usage.inputTokens);
    const outputTokens = count(decision.usage.outputTokens);
    // A confidence fallback can still consume Jev tokens. Its source alone is
    // insufficient: billable metadata records what actually reached the API.
    const billable =
      decision.source !== "mock" &&
      (decision.usage.billable ?? decision.source === "jev");
    if (billable) {
      this.inputTokens += inputTokens;
      this.outputTokens += outputTokens;
      this.estimatedCostUsd += estimateCostUsd(
        { inputTokens, outputTokens, billable: true },
        this.pricing,
      );
    } else {
      this.simulatedInputTokens += inputTokens;
      this.simulatedOutputTokens += outputTokens;
    }
    const latency = decision.timing.roundTripMs;
    if (latency !== null && Number.isFinite(latency) && latency >= 0) {
      this.latestLatencyMs = latency;
      this.latencies.push(latency);
      if (this.latencies.length > LATENCY_LIMIT) this.latencies.shift();
    }
  }

  private recordIncident(incident: Omit<SessionIncident, "id" | "atMs">) {
    this.incidentCount += 1;
    this.incidents.unshift({
      id: `event-${this.nextId++}`,
      atMs: this.elapsed(),
      ...incident,
    });
    if (this.incidents.length > HISTORY_LIMIT) this.incidents.pop();
  }

  record(
    snapshot: AgentGameState,
    decision: AgentDecision,
    rawResponse: unknown,
    appliedAction?: AppliedDecision,
  ): DecisionEvent {
    const nowMs = this.now();
    this.accepted += 1;
    this.observe(decision);
    this.acceptedAt.push(nowMs);
    this.pruneRateWindow(nowMs);
    const event: DecisionEvent = {
      id: `decision-${this.nextId++}`,
      atMs: this.elapsed(nowMs),
      snapshot: structuredClone(snapshot),
      decision: structuredClone(decision),
      rawResponse: safeValue(rawResponse),
      ...(appliedAction
        ? { appliedAction: structuredClone(appliedAction) }
        : {}),
    };
    this.history.unshift(event);
    if (this.history.length > HISTORY_LIMIT) this.history.pop();
    if (decision.source === "fallback") {
      this.fallbackCount += 1;
      this.recordIncident({
        kind: "fallback",
        sequence: decision.sequence,
        requestId: decision.requestId,
        reason: decision.fallbackReason,
      });
    }
    return structuredClone(event);
  }

  /** Pass a returned stale decision to include its actual token cost and latency. */
  recordStale(decision?: AgentDecision): void {
    this.staleDiscarded += 1;
    if (decision) this.observe(decision);
    this.recordIncident({
      kind: "stale_discarded",
      sequence: decision?.sequence,
      requestId: decision?.requestId,
    });
  }

  private pruneRateWindow(nowMs: number) {
    const cutoff = nowMs - RATE_WINDOW_MS;
    while (this.acceptedAt.length && this.acceptedAt[0] <= cutoff) {
      this.acceptedAt.shift();
    }
  }

  getMetrics(nowMs = this.now()): SessionMetrics {
    this.pruneRateWindow(nowMs);
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      accepted: this.accepted,
      staleDiscarded: this.staleDiscarded,
      observedResponses: this.observedResponses,
      fallbackCount: this.fallbackCount,
      fallbackRate: this.accepted ? this.fallbackCount / this.accepted : 0,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      simulatedInputTokens: this.simulatedInputTokens,
      simulatedOutputTokens: this.simulatedOutputTokens,
      estimatedCostUsd: this.estimatedCostUsd,
      decisionsPerSecond: this.acceptedAt.length / (RATE_WINDOW_MS / 1_000),
      rateWindowMs: RATE_WINDOW_MS,
      latestLatencyMs: this.latestLatencyMs,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
      latencySamples: this.latencies.length,
    };
  }

  /** Newest first; callers cannot mutate the stored history. */
  getHistory(): DecisionEvent[] {
    return structuredClone(this.history);
  }

  exportSession(
    score: { human: number; agent: number },
    outcome: string | null,
    config: SessionExportConfig = {},
  ) {
    const nowMs = this.now();
    return {
      appVersion: this.appVersion,
      elapsedMs: this.elapsed(nowMs),
      matchConfiguration: safeValue(config.match ?? {}),
      modelConfiguration: safeValue(config.model ?? {}),
      score: { human: count(score.human), agent: count(score.agent) },
      outcome,
      metrics: this.getMetrics(nowMs),
      pricing: { ...this.pricing, estimated: true },
      events: this.history.map((event) => redactSecrets(event)),
      fallbackAndErrorEvents: this.incidents.map((event) => safeValue(event)),
      retention: {
        historyLimit: HISTORY_LIMIT,
        retainedDecisions: this.history.length,
        omittedDecisions: this.accepted - this.history.length,
        retainedIncidents: this.incidents.length,
        omittedIncidents: this.incidentCount - this.incidents.length,
        latencyWindow: LATENCY_LIMIT,
        truncated:
          this.accepted > HISTORY_LIMIT || this.incidentCount > HISTORY_LIMIT,
      },
    };
  }
}

export type SessionExport = ReturnType<SessionTelemetry["exportSession"]>;
