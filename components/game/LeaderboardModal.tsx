"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { DIFFICULTY_LEVELS, type DifficultyLevel } from "@/lib/game/constants";
import {
  formatRaceTime,
  leaderboardPageSchema,
  type LeaderboardPage,
} from "@/lib/leaderboard/contracts";

const PAGE_SIZE = 50;

async function fetchPage(
  level: DifficultyLevel,
  query: string,
  offset: number,
  signal: AbortSignal,
) {
  const search = new URLSearchParams({
    difficulty: String(level),
    view: "full",
    q: query,
    offset: String(offset),
    limit: String(PAGE_SIZE),
  });
  const response = await fetch(`/api/leaderboard?${search}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("The leaderboard couldn’t load.");
  return leaderboardPageSchema.parse(await response.json());
}

export default function LeaderboardModal({
  initialLevel,
  onClose,
}: {
  initialLevel: DifficultyLevel;
  onClose: () => void;
}) {
  const [level, setLevel] = useState(initialLevel);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState<LeaderboardPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const loadMarker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      setPage(null);
      try {
        const next = await fetchPage(
          level,
          debouncedQuery,
          0,
          AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
        );
        if (!abort.signal.aborted) setPage(next);
      } catch (reason) {
        if (!abort.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "The leaderboard couldn’t load.",
          );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [debouncedQuery, level]);

  const loadMore = useCallback(async () => {
    if (!page?.nextOffset || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await fetchPage(
        level,
        debouncedQuery,
        page.nextOffset,
        AbortSignal.timeout(15000),
      );
      setPage((current) =>
        current
          ? {
              ...next,
              entries: [...current.entries, ...next.entries],
            }
          : next,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The leaderboard couldn’t load.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [debouncedQuery, level, loadingMore, page]);

  useEffect(() => {
    const marker = loadMarker.current;
    if (!marker || !page?.nextOffset || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { root: scrollRoot.current, rootMargin: "160px 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [error, loadMore, page?.nextOffset]);

  const available = page?.totalPlayers ?? 0;

  return (
    <Modal title="Global leaderboard" onClose={onClose} wide>
      <div className="leaderboard-modal-intro">
        <span>GLOBAL PERSONAL BESTS</span>
        <p>Fastest recorded finish on each level.</p>
      </div>
      <div
        className="leaderboard-levels leaderboard-modal-levels"
        role="group"
        aria-label="Full leaderboard difficulty"
      >
        {([1, 2, 3] as const).map((value) => (
          <button
            key={value}
            aria-label={`${DIFFICULTY_LEVELS[value].label} full leaderboard`}
            aria-pressed={value === level}
            onClick={() => setLevel(value)}
          >
            {DIFFICULTY_LEVELS[value].label}
          </button>
        ))}
      </div>
      <label className="leaderboard-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search players by name</span>
        <input
          autoFocus
          type="search"
          value={query}
          maxLength={18}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search player name"
          autoComplete="off"
        />
        {query !== debouncedQuery && <span>SEARCHING</span>}
      </label>
      <div
        ref={scrollRoot}
        className="leaderboard-modal-scroll"
        aria-busy={loading || loadingMore}
      >
        {loading ? (
          <div className="leaderboard-modal-state" role="status">
            <LoaderCircle className="spin" size={18} /> Loading standings…
          </div>
        ) : error && !page ? (
          <div className="leaderboard-modal-state" role="alert">
            {error}
          </div>
        ) : page?.entries.length === 0 ? (
          <div className="leaderboard-modal-state">
            {debouncedQuery
              ? `No players match “${debouncedQuery}”.`
              : `No ${DIFFICULTY_LEVELS[level].label.toLowerCase()} results yet.`}
          </div>
        ) : (
          <>
            <table className="leaderboard-table leaderboard-full-table">
              <caption className="sr-only">
                Full leaderboard on {DIFFICULTY_LEVELS[level].label}
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
                {page?.entries.map((entry) => (
                  <tr key={entry.matchId}>
                    <td>#{entry.rank}</td>
                    <th scope="row">{entry.playerName}</th>
                    <td>{formatRaceTime(entry.durationMs)}</td>
                    <td>
                      {entry.humanScore}–{entry.aiScore}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div ref={loadMarker} className="leaderboard-load-marker">
              {loadingMore && (
                <span role="status">
                  <LoaderCircle className="spin" size={15} /> Loading more…
                </span>
              )}
              {error && (
                <button onClick={() => void loadMore()}>{error} Retry</button>
              )}
              {page?.nextOffset && !loadingMore && !error && (
                <button onClick={() => void loadMore()}>Load more</button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="leaderboard-modal-footer" aria-live="polite">
        <span>
          {debouncedQuery && page
            ? `${page.matchingPlayers} matching ${page.matchingPlayers === 1 ? "player" : "players"}`
            : `${available} ranked ${available === 1 ? "player" : "players"} available`}
        </span>
        <span>{page?.entries.length ?? 0} shown</span>
      </div>
    </Modal>
  );
}
