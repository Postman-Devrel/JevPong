import { describe, expect, it, vi } from "vitest";
import {
  MatchRecorder,
  type RecordingState,
} from "../../lib/leaderboard/client";
import { formatRaceTime } from "../../lib/leaderboard/contracts";
import { PongEngine } from "../../lib/game/engine";
import { createFallbackDecision } from "../../lib/agent/decision-controller";
import { baseState } from "../fixtures/agent-states";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LeaderboardResult } from "../../components/game/Leaderboard";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("match recording", () => {
  it("shows a returned rank and personal-best time on the result card", () => {
    const markup = renderToStaticMarkup(
      createElement(LeaderboardResult, {
        onRetry: () => {},
        recording: {
          status: "saved",
          result: {
            matchId: "match",
            ranked: true,
            reason: null,
            rank: 4,
            personalBest: true,
            durationMs: 65430,
            board: {
              difficulty: 3,
              entries: [],
              totalPlayers: 12,
              personalBest: null,
              updatedAt: "2026-09-22T12:00:00.000Z",
            },
          },
        },
      }),
    );
    expect(markup).toContain("#4 on Hard");
    expect(markup).toContain("1:05.43");
    expect(markup).toContain("Your personal best");
  });
  it("counts only this match's decisions and retains a strategy-change flag", async () => {
    const payloads: Record<string, unknown>[] = [];
    const recorder = new MatchRecorder({
      playerName: () => "Ada",
      onChange: () => {},
      fetcher: async (path, init) => {
        if (String(path).endsWith("start"))
          return Response.json({ ticket: "ticket", matchId: "match" });
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json({}, { status: 503 });
      },
    });
    const engine = new PongEngine();
    engine.start();
    recorder.observe(engine.state, "balanced");
    const decision = createFallbackDecision(
      { ...baseState, matchId: engine.state.matchId },
      "timeout",
    );
    recorder.decision(decision);
    recorder.observe(engine.state, "aggressive");
    recorder.observe(engine.state, "balanced");
    Object.assign(engine.state, {
      phase: "finished",
      elapsed: 50,
      score: { human: 7, ai: 0 },
    });
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(payloads[0]).toMatchObject({
      fallbackDecisions: 1,
      strategyChanged: true,
    });
    engine.restart();
    recorder.observe(engine.state, "balanced");
    recorder.decision(decision); // Late response from the previous match.
    recorder.decision({
      ...decision,
      matchId: engine.state.matchId,
      source: "jev",
    });
    Object.assign(engine.state, {
      phase: "finished",
      elapsed: 60,
      score: { human: 7, ai: 1 },
    });
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(payloads[1]).toMatchObject({
      liveDecisions: 1,
      fallbackDecisions: 0,
      strategyChanged: false,
    });
    recorder.dispose();
  });
  it("formats hundredths and carries rounding correctly", () => {
    expect(formatRaceTime(59999)).toBe("1:00.00");
    expect(formatRaceTime(123450)).toBe("2:03.45");
  });
  it("registers once, freezes the result and retries the same payload after a failed save", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const states: RecordingState[] = [];
    const fetcher = vi.fn(async (path, init) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      if (String(path).endsWith("start"))
        return Response.json({ ticket: "ticket", matchId: "stored-match" });
      return Response.json({ error: "storage_unavailable" }, { status: 503 });
    }) as typeof fetch;
    const recorder = new MatchRecorder({
      playerName: () => "Ada",
      onChange: (state) => states.push(state),
      fetcher,
    });
    const engine = new PongEngine();
    engine.start();
    recorder.observe(engine.state, "balanced");
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(calls).toHaveLength(1);
    Object.assign(engine.state, {
      phase: "finished",
      winner: "human",
      score: { human: 7, ai: 0 },
      elapsed: 55,
    });
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(states.at(-1)?.status).toBe("error");
    recorder.retry();
    await flush();
    expect(calls[1].body).toEqual(calls[2].body);
    expect(calls[1].body.durationMs).toBe(55000);
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(calls).toHaveLength(3);
    recorder.dispose();
  });
  it("keeps gameplay independent of a missing sheet and never claims a save", async () => {
    const states: RecordingState[] = [];
    const recorder = new MatchRecorder({
      playerName: () => "Ada",
      onChange: (state) => states.push(state),
      fetcher: vi.fn(async () =>
        Response.json({ error: "leaderboard_not_configured" }, { status: 503 }),
      ),
    });
    const engine = new PongEngine();
    engine.start();
    recorder.observe(engine.state, "balanced");
    await flush();
    expect(states.at(-1)?.status).toBe("unavailable");
    expect(engine.state.phase).toBe("countdown");
    recorder.dispose();
  });
});
