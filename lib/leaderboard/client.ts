import type { AgentDecision, Strategy } from "../agent/contracts";
import type { GameState } from "../game/engine";
import {
  finishMatchSchema,
  nicknameSchema,
  resultSchema,
  startResponseSchema,
  type FinishMatch,
  type MatchResult,
} from "./contracts";

export type RecordingState = {
  status:
    | "idle"
    | "registering"
    | "playing"
    | "saving"
    | "saved"
    | "error"
    | "unavailable";
  message?: string;
  result?: MatchResult;
};
type Match = {
  id: string;
  live: number;
  fallback: number;
  mock: number;
  strategy: Strategy;
  strategyChanged: boolean;
  registration: Promise<string | null>;
  payload?: FinishMatch;
  finished: boolean;
  sending: boolean;
};

async function post(
  path: string,
  payload: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error === "leaderboard_not_configured"
        ? "not_configured"
        : "unavailable",
    );
  }
  return response.json();
}

/** Tracks each match independently from the session-wide telemetry counters. */
export class MatchRecorder {
  private match: Match | null = null;
  private abort = new AbortController();
  constructor(
    private readonly options: {
      playerName: () => string;
      onChange: (state: RecordingState) => void;
      fetcher?: typeof fetch;
    },
  ) {}
  private emit(match: Match, state: RecordingState) {
    if (this.match === match && !this.abort.signal.aborted)
      this.options.onChange(state);
  }
  observe(state: GameState, strategy: Strategy) {
    if (state.phase === "ready") {
      if (this.match) {
        this.match = null;
        this.options.onChange({ status: "idle" });
      }
      return;
    }
    if (!this.match || this.match.id !== state.matchId) {
      const match: Match = {
        id: state.matchId,
        live: 0,
        fallback: 0,
        mock: 0,
        strategy,
        strategyChanged: false,
        registration: Promise.resolve(null),
        finished: false,
        sending: false,
      };
      this.match = match;
      const name = nicknameSchema.safeParse(
        this.options.playerName().trim() || "Player 01",
      );
      if (!name.success) {
        this.emit(match, {
          status: "unavailable",
          message:
            "This nickname cannot be listed. Use up to 18 characters: letters, numbers, spaces, or . _ ' -. Start with a letter or number.",
        });
      } else {
        this.emit(match, { status: "registering" });
        match.registration = post(
          "/api/leaderboard/start",
          {
            clientMatchId: state.matchId,
            playerName: name.data,
            difficulty: state.difficulty,
            strategy,
          },
          this.abort.signal,
          this.options.fetcher ?? fetch,
        )
          .then((raw) => {
            const data = startResponseSchema.parse(raw);
            if (!match.finished) this.emit(match, { status: "playing" });
            return data.ticket;
          })
          .catch((error) => {
            this.emit(match, {
              status: "unavailable",
              message:
                error instanceof Error && error.message === "not_configured"
                  ? "Leaderboard is not connected yet. This match won’t be listed."
                  : "Couldn’t register this match. You can still play, but this run won’t be listed.",
            });
            return null;
          });
      }
    }
    const match = this.match;
    if (strategy !== match.strategy) match.strategyChanged = true;
    if (state.phase === "finished" && !match.finished) {
      match.finished = true;
      // Freeze result at the finish event, before a rematch resets game state.
      const result = {
        durationMs: Math.round(state.elapsed * 1000),
        humanScore: state.score.human,
        aiScore: state.score.ai,
        liveDecisions: match.live,
        fallbackDecisions: match.fallback,
        mockDecisions: match.mock,
        strategyChanged: match.strategyChanged,
      };
      void match.registration
        .then((ticket) => {
          if (!ticket || this.abort.signal.aborted) return;
          match.payload = finishMatchSchema.parse({ ...result, ticket });
          return this.submit(match);
        })
        .catch(() =>
          this.emit(match, {
            status: "unavailable",
            message:
              "This result is outside the leaderboard’s supported match limits.",
          }),
        );
    }
  }
  decision(decision: AgentDecision) {
    const match = this.match;
    if (!match || match.id !== decision.matchId || match.finished) return;
    if (decision.source === "jev") match.live++;
    else if (decision.source === "mock") match.mock++;
    else match.fallback++;
  }
  private async submit(match: Match) {
    if (!match.payload || match.sending || this.abort.signal.aborted) return;
    match.sending = true;
    this.emit(match, { status: "saving" });
    try {
      const result = resultSchema.parse(
        await post(
          "/api/leaderboard/finish",
          match.payload,
          this.abort.signal,
          this.options.fetcher ?? fetch,
        ),
      );
      this.emit(match, { status: "saved", result });
    } catch {
      this.emit(match, {
        status: "error",
        message:
          "Your result hasn’t been confirmed. Retry to save it and get your rank.",
      });
    } finally {
      match.sending = false;
    }
  }
  retry() {
    if (this.match) void this.submit(this.match);
  }
  dispose() {
    this.abort.abort();
  }
}
