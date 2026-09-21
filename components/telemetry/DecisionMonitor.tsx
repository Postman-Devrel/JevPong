"use client";

import {
  ArrowDown,
  ArrowUp,
  Minus,
  Activity,
  ChevronDown,
  Zap,
  ArrowUpRight,
  Radio,
} from "lucide-react";
import type {
  AgentDecision,
  AgentGameState,
  AgentPublicConfig,
  Movement,
} from "@/lib/agent/contracts";

export type MonitorMetrics = {
  accepted: number;
  staleDiscarded: number;
  fallbackCount: number;
  fallbackRate: number;
  inputTokens: number;
  outputTokens: number;
  simulatedInputTokens: number;
  simulatedOutputTokens: number;
  estimatedCostUsd: number;
  decisionsPerSecond: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

const formatMs = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n)} ms`;
export function sourceName(source?: string) {
  return source === "connecting"
    ? "CONNECTING"
    : source === "jev"
      ? "JEV LIVE"
      : source === "fallback"
        ? "FALLBACK"
        : "MOCK";
}
export function decisionStatus(
  decision: AgentDecision | null,
  pending: boolean,
  config: AgentPublicConfig | null,
) {
  if (!decision && !config) return "Connecting to agent…";
  if (!decision)
    return config?.provider === "jev"
      ? config.configured
        ? "Jev ready"
        : "Jev unavailable"
      : "Mock mode";
  if (decision.source === "fallback") {
    return {
      low_confidence: "Low confidence · fallback active",
      timeout: "Jev timed out · fallback active",
      rate_limit: "Rate limited · retrying",
      offline: "Offline · fallback active",
      missing_credentials: "Jev unavailable · no API key",
      authentication: "Authentication failed · fallback active",
      configuration: "Configuration error · fallback active",
      invalid_response: "Invalid response · fallback active",
      provider_error: "Provider unavailable · fallback active",
    }[decision.fallbackReason ?? "provider_error"];
  }
  return decision.source === "mock"
    ? "Mock mode · simulated decisions"
    : pending
      ? "Jev deciding"
      : "Jev connected";
}

function ProbabilityBar({
  label,
  value,
  active,
  orange = false,
}: {
  label: string;
  value?: number;
  active?: boolean;
  orange?: boolean;
}) {
  return (
    <div
      className={`probability-row ${active ? "probability-active" : ""} ${orange ? "orange" : ""}`}
    >
      <span>{label}</span>
      <div className="probability-track">
        <i style={{ width: `${(value ?? 0) * 100}%` }} />
      </div>
      <b>{value == null ? "—" : `${Math.round(value * 100)}%`}</b>
    </div>
  );
}

export default function DecisionMonitor({
  decision,
  snapshot,
  metrics,
  config,
  pending,
  playing,
  explanation,
  currentMovement,
  onInspect,
}: {
  decision: AgentDecision | null;
  snapshot: AgentGameState | null;
  metrics: MonitorMetrics;
  config: AgentPublicConfig | null;
  pending: boolean;
  playing: boolean;
  explanation: string | null;
  currentMovement?: Movement;
  onInspect: () => void;
}) {
  const source =
    decision?.source ??
    (!config ? "connecting" : config.provider === "jev" ? "jev" : "mock");
  const movement = currentMovement ?? decision?.movement;
  const MovementIcon =
    movement === "UP" ? ArrowUp : movement === "DOWN" ? ArrowDown : Minus;
  const competitors = decision
    ? Object.entries(decision.movementProbabilities)
        .filter(([key]) => key !== movement)
        .sort((a, b) => b[1] - a[1])
    : [];
  return (
    <aside className="monitor panel" aria-label="Agent Decision Monitor">
      <div className="panel-heading">
        <div>
          <Activity size={16} />
          <span>DECISION MONITOR</span>
        </div>
        <span className={`source-badge ${source}`}>{sourceName(source)}</span>
      </div>
      <div className="monitor-body">
        <div className="monitor-status">
          <span
            className={`signal-dot ${playing && pending ? "pulse" : ""} ${source === "fallback" ? "warning" : ""}`}
          />
          {decisionStatus(decision, pending, config)}
        </div>
        <div
          className={`current-action ${source === "fallback" ? "fallback-action" : ""}`}
        >
          <div className="action-symbol">
            <MovementIcon size={27} strokeWidth={1.5} />
          </div>
          <div>
            <span className="eyebrow">
              {playing ? "CURRENT ACTION" : "LATEST ACTION"}
            </span>
            <h2>
              {movement
                ? movement === "HOLD"
                  ? "Hold position"
                  : `Move ${movement.toLowerCase()}`
                : "Ready when you are"}
            </h2>
          </div>
          {decision && (
            <div className="confidence">
              <strong>
                {decision.model === "deterministic-fallback" ||
                decision.model === "fallback-controller"
                  ? "—"
                  : Math.round(decision.movementConfidence * 100)}
                {decision.model !== "deterministic-fallback" &&
                  decision.model !== "fallback-controller" && <small>%</small>}
              </strong>
              <span>confidence</span>
            </div>
          )}
        </div>
        <p className="decision-explanation">
          {explanation ??
            "Your move starts the match. Every agent decision appears here, as it happens."}
        </p>
        <div className="probability-section">
          <div className="section-caption">
            <span>MOVEMENT</span>
            <span>PROBABILITY</span>
          </div>
          {(["UP", "DOWN", "HOLD"] as const).map((key) => (
            <ProbabilityBar
              key={key}
              label={key}
              value={decision?.movementProbabilities[key]}
              active={movement === key}
            />
          ))}
        </div>
        <div className="probability-section return-section">
          <div className="section-caption">
            <span>RETURN STYLE</span>
            <span>NEXT HIT</span>
          </div>
          {(["SAFE", "ANGLED", "FAST"] as const).map((key) => (
            <ProbabilityBar
              key={key}
              label={key}
              value={decision?.returnStyleProbabilities[key]}
              active={decision?.returnStyle === key}
              orange
            />
          ))}
        </div>
        <div className="boost-decision">
          <span>
            <Zap size={13} /> USE BOOST
          </span>
          <div className="mini-track">
            <i
              style={{
                width: `${(decision?.useBoostProbability ?? 0) * 100}%`,
              }}
            />
          </div>
          <b>
            {decision
              ? `${Math.round(decision.useBoostProbability * 100)}%`
              : "—"}
          </b>
        </div>
        <div className="quick-metrics">
          <div>
            <span>ROUND TRIP</span>
            <strong>{formatMs(decision?.timing.roundTripMs)}</strong>
          </div>
          <div>
            <span>DECISIONS / SEC</span>
            <strong>
              {metrics.decisionsPerSecond.toFixed(1)}
              <span className="metric-live">measured</span>
            </strong>
          </div>
        </div>
        <details className="monitor-details">
          <summary>
            Session performance <ChevronDown size={14} />
          </summary>
          <div className="detail-metrics">
            <span>Model returned</span>
            <b className="model-value">
              {decision?.model ?? "Awaiting first decision"}
            </b>
            <span>Latency p50 / p95</span>
            <b>
              {formatMs(metrics.latencyP50Ms)} /{" "}
              {formatMs(metrics.latencyP95Ms)}
            </b>
            <span>Accepted / stale</span>
            <b>
              {metrics.accepted} / {metrics.staleDiscarded}
            </b>
            <span>Fallbacks</span>
            <b>
              {metrics.fallbackCount} ({Math.round(metrics.fallbackRate * 100)}
              %)
            </b>
            <span>Latest input tokens</span>
            <b>
              {decision?.usage.inputTokens ?? "—"}
              {decision?.usage.billable === false &&
              decision.usage.inputTokens > 0
                ? " simulated"
                : ""}
            </b>
            <span>Live input / output</span>
            <b>
              {metrics.inputTokens.toLocaleString()} /{" "}
              {metrics.outputTokens.toLocaleString()}
            </b>
            <span>Simulated tokens</span>
            <b>
              {(
                metrics.simulatedInputTokens + metrics.simulatedOutputTokens
              ).toLocaleString()}
            </b>
            <span>Estimated session cost</span>
            <b>${metrics.estimatedCostUsd.toFixed(6)}</b>
            {competitors.length > 0 && (
              <>
                <span>Top alternative</span>
                <b>
                  {competitors[0][0]} · {Math.round(competitors[0][1] * 100)}%
                </b>
              </>
            )}
            {snapshot && (
              <>
                <span>Predicted intercept</span>
                <b>
                  {snapshot.prediction.interceptY == null
                    ? "Recentering"
                    : `${Math.round(snapshot.prediction.interceptY)} px`}
                </b>
              </>
            )}
          </div>
        </details>
        <button className="inspect-button" onClick={onInspect}>
          <span>
            <Radio size={14} /> Inspect the decision
          </span>
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="monitor-footnote">
        Structured outputs. Observable decisions.
      </div>
    </aside>
  );
}
