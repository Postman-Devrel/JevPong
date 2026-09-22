"use client";

import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw, Trophy } from "lucide-react";
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
} from "@/lib/game/constants";
import {
  boardSchema,
  formatRaceTime,
  type Leaderboard as Board,
} from "@/lib/leaderboard/contracts";
import type { RecordingState } from "@/lib/leaderboard/client";

const REASONS = {
  loss: "Match logged. Beat Jev to earn a place on this board.",
  practice:
    "Practice match logged. Only live Jev matches enter the leaderboard.",
  fallback:
    "Match logged, but not ranked: Jev used fallback play during this run.",
  strategy:
    "Match logged, but not ranked: ranked runs use Balanced style throughout.",
  no_live_decisions:
    "Match logged, but not ranked: no live Jev decisions were recorded.",
  insufficient_live_decisions:
    "Match logged, but not ranked: Fabric/Jev made less than 70% of the decisions.",
  hidden: "Match logged. This result is not publicly listed.",
};

export function LeaderboardResult({
  recording,
  onRetry,
}: {
  recording: RecordingState;
  onRetry: () => void;
}) {
  const result = recording.result;
  return (
    <div className="leaderboard-result" role="status" aria-live="polite">
      <Trophy size={21} aria-hidden="true" />
      <div>
        {recording.status === "saved" && result ? (
          <>
            <strong>
              {result.ranked
                ? `#${result.rank} on ${DIFFICULTY_LEVELS[result.board.difficulty].label}`
                : "Match recorded"}
            </strong>
            <p>
              {result.ranked
                ? `${formatRaceTime(result.durationMs)}${result.personalBest ? " · Your personal best" : ` · Personal best: ${formatRaceTime(result.board.personalBest?.durationMs ?? result.durationMs)}`}`
                : REASONS[result.reason ?? "hidden"]}
            </p>
          </>
        ) : (
          <>
            <strong>
              {recording.status === "saving" ||
              recording.status === "registering" ||
              recording.status === "playing"
                ? "Saving your result…"
                : "Leaderboard result unavailable"}
            </strong>
            <p>
              {recording.message ??
                "Your position will appear here once the result is saved."}
            </p>
          </>
        )}
      </div>
      {recording.status === "error" ? (
        <button className="secondary-button" onClick={onRetry}>
          Retry save
        </button>
      ) : (
        <a href="#leaderboard" aria-label="View global leaderboard">
          <ArrowRight size={20} />
        </a>
      )}
    </div>
  );
}

export default function Leaderboard({
  latestResult,
}: {
  latestResult?: RecordingState["result"];
}) {
  const [level, setLevel] = useState<DifficultyLevel>(DEFAULT_DIFFICULTY);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    board: Board | null;
    loading: boolean;
    error: string | null;
  }>({ board: null, loading: true, error: null });
  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    async function load() {
      setState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const response = await fetch(`/api/leaderboard?difficulty=${level}`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
          cache: "no-store",
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            data.error === "leaderboard_not_configured"
              ? "The global leaderboard is coming soon. Scores are not being saved yet."
              : "The leaderboard couldn’t load. Try refreshing it.",
          );
        }
        const board = boardSchema.parse(await response.json());
        if (!cancelled) setState({ board, loading: false, error: null });
      } catch (error) {
        if (!cancelled)
          setState({
            board: null,
            loading: false,
            error:
              error instanceof Error && error.message.startsWith("The ")
                ? error.message
                : "The leaderboard couldn’t load. Try refreshing it.",
          });
      }
    }
    void load();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [level, revision, latestResult]);
  const board =
    latestResult?.board.difficulty === level && state.loading
      ? latestResult.board
      : state.board;
  const visible = board?.difficulty === level ? board : null;
  return (
    <section
      className="leaderboard-section panel"
      id="leaderboard"
      aria-labelledby="leaderboard-title"
    >
      <div className="leaderboard-heading">
        <div>
          <span className="eyebrow">THE GLOBAL LEADERBOARD</span>
          <h2 id="leaderboard-title">Who finishes fastest?</h2>
          <p>70% live Jev required. One personal best per player.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh leaderboard"
          onClick={() => setRevision((value) => value + 1)}
          disabled={state.loading}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <div
        className="leaderboard-levels"
        role="group"
        aria-label="Leaderboard difficulty"
      >
        {([1, 2, 3] as const).map((value) => (
          <button
            key={value}
            aria-label={`${DIFFICULTY_LEVELS[value].label} leaderboard`}
            aria-pressed={value === level}
            onClick={() => setLevel(value)}
          >
            {DIFFICULTY_LEVELS[value].label}
          </button>
        ))}
      </div>
      <div className="leaderboard-body" aria-busy={state.loading}>
        {state.error ? (
          <p className="leaderboard-empty" role="status">
            {state.error}
          </p>
        ) : !visible ? (
          <p className="leaderboard-empty" role="status">
            Loading the fastest matches…
          </p>
        ) : visible.entries.length === 0 ? (
          <p className="leaderboard-empty">
            No completed matches on {DIFFICULTY_LEVELS[level].label} yet. Be the
            first to play.
          </p>
        ) : (
          <>
            <table className="leaderboard-table">
              <caption className="sr-only">
                Fastest completed matches on {DIFFICULTY_LEVELS[level].label}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Player</th>
                  <th scope="col">Time</th>
                  <th scope="col">Score</th>
                </tr>
              </thead>
              <tbody>
                {visible.entries.map((entry) => (
                  <tr
                    key={entry.matchId}
                    className={
                      entry.matchId === visible.personalBest?.matchId
                        ? "is-you"
                        : ""
                    }
                  >
                    <td>#{entry.rank}</td>
                    <th scope="row">
                      {entry.playerName}
                      {entry.matchId === visible.personalBest?.matchId && (
                        <span className="leaderboard-you">You</span>
                      )}
                    </th>
                    <td>{formatRaceTime(entry.durationMs)}</td>
                    <td>
                      {entry.humanScore}–{entry.aiScore}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.personalBest && (
              <div className="leaderboard-personal">
                <span>Your best on {DIFFICULTY_LEVELS[level].label}</span>
                <strong>
                  #{visible.personalBest.rank}{" "}
                  <span>{formatRaceTime(visible.personalBest.durationMs)}</span>
                </strong>
              </div>
            )}
          </>
        )}
      </div>
      <div className="leaderboard-rules">
        <p>
          Completed matches rank when Fabric/Jev makes at least 70% of all
          decisions. Losses, every strategy, and fallback play are allowed. Time
          includes countdowns, excludes pauses. Equal times share a rank.
        </p>
        <p>
          Community leaderboard: browser-reported results, not cheat-proof. Your
          nickname and result are public. Personal bests are tied to this
          browser, not a verified account.
        </p>
        {visible && (
          <span>
            {visible.totalPlayers} ranked{" "}
            {visible.totalPlayers === 1 ? "player" : "players"} on{" "}
            {DIFFICULTY_LEVELS[level].label} · Top 20 shown
          </span>
        )}
      </div>
    </section>
  );
}
