import type { AgentDecision, AgentGameState } from "./contracts";
import type { AppliedDecision } from "../game/engine";
import { ACTION_POLICY } from "../game/constants";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Observable facts only: this is a deterministic explanation, never model reasoning. */
export function explainDecision(
  snapshot: AgentGameState,
  decision: AgentDecision,
  applied?: AppliedDecision,
): string {
  if (decision.source === "fallback") {
    const reason = (
      decision.fallbackReason ?? "provider unavailable"
    ).replaceAll("_", " ");
    return `${reason.charAt(0).toUpperCase() + reason.slice(1)}. Simple code ${snapshot.ball.movingTowardAgent ? "tracks the predicted intercept" : "recenters the paddle slowly"}; SAFE return, no boost.`;
  }
  const intercept = snapshot.prediction.interceptY;
  const delta =
    intercept === null
      ? null
      : Math.round(intercept - snapshot.agentPaddle.centerY);
  const location =
    delta === null
      ? "The ball is moving away."
      : Math.abs(delta) < 12
        ? "The predicted intercept is aligned with the paddle."
        : `The predicted intercept is ${Math.abs(delta)} px ${delta < 0 ? "above" : "below"} the paddle.`;
  const ranked = Object.entries(decision.movementProbabilities).sort(
    (a, b) => b[1] - a[1],
  );
  const vote = `${decision.movement} received ${percent(decision.movementProbabilities[decision.movement])}; ${ranked.find(([name]) => name !== decision.movement)?.[0] ?? "HOLD"} is the next option at ${percent(ranked.find(([name]) => name !== decision.movement)?.[1] ?? 0)}.`;
  const gate =
    decision.movementConfidence < ACTION_POLICY.fullMovementConfidence
      ? " Code limits movement to 70% speed and disables boost."
      : applied?.movement === "HOLD" && decision.movement !== "HOLD"
        ? " Code stops movement at the intercept."
        : " Code bounds movement and stops at the intercept.";
  return `${location} ${vote}${gate}`;
}

export const getDecisionExplanation = explainDecision;
