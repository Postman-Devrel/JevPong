"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { explainDecision } from "@/lib/agent/explanation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  Download,
  Expand,
  Gamepad2,
  GitFork,
  HelpCircle,
  Keyboard,
  MousePointer2,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Sparkles,
  Trophy,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { PongEngine, type GameState } from "@/lib/game/engine";
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTY_LEVELS,
  GAME,
  type DifficultyLevel,
} from "@/lib/game/constants";
import { DecisionController } from "@/lib/agent/decision-controller";
import { agentPublicConfigSchema } from "@/lib/agent/contracts";
import type {
  AgentDecisionResponse,
  AgentGameState,
  AgentPublicConfig,
  MockScenario,
  Strategy,
} from "@/lib/agent/contracts";
import { SessionTelemetry, type DecisionEvent } from "@/lib/telemetry/session";
import DecisionMonitor, {
  sourceName,
  type MonitorMetrics,
} from "@/components/telemetry/DecisionMonitor";
import RawInspector from "@/components/telemetry/RawInspector";
import Modal from "@/components/ui/Modal";
import ResultShareModal from "@/components/game/ResultShareModal";
import {
  normalizePlayerName,
  type ResultLeaderboardData,
  type ResultCardData,
} from "@/lib/share/result-card";
import { ArcadeAudio } from "./audio";
import { CourtRenderer } from "./renderer";
import Leaderboard, { LeaderboardResult } from "./Leaderboard";
import { MatchRecorder, type RecordingState } from "@/lib/leaderboard/client";
import { formatRaceTime } from "@/lib/leaderboard/contracts";

const EMPTY_METRICS: MonitorMetrics = {
  accepted: 0,
  staleDiscarded: 0,
  fallbackCount: 0,
  fallbackRate: 0,
  inputTokens: 0,
  outputTokens: 0,
  simulatedInputTokens: 0,
  simulatedOutputTokens: 0,
  estimatedCostUsd: 0,
  decisionsPerSecond: 0,
  latencyP50Ms: null,
  latencyP95Ms: null,
};
type Runtime = {
  engine: PongEngine;
  controller: DecisionController | null;
  session: SessionTelemetry;
  audio: ArcadeAudio;
  renderer: CourtRenderer;
  recorder: MatchRecorder;
};

export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const courtRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const scenarioRef = useRef<MockScenario>("normal");
  const soundEnabledRef = useRef(true);
  const playerNameRef = useRef("");
  const [recording, setRecording] = useState<RecordingState>({
    status: "idle",
  });
  const [view, setView] = useState<GameState | null>(null);
  const [config, setConfig] = useState<AgentPublicConfig | null>(null);
  const [latest, setLatest] = useState<DecisionEvent | null>(null);
  const [history, setHistory] = useState<DecisionEvent[]>([]);
  const [metrics, setMetrics] = useState<MonitorMetrics>(EMPTY_METRICS);
  const [pending, setPending] = useState(false);
  const [sound, setSound] = useState(true);
  const [playerName, setPlayerName] = useState("");
  useEffect(() => {
    playerNameRef.current = playerName;
  }, [playerName]);
  const [strategy, setStrategy] = useState<Strategy>("balanced");
  const [scenario, setScenario] = useState<MockScenario>("normal");
  const [modal, setModal] = useState<
    "help" | "restart" | "difficulty" | "inspect" | "share" | null
  >(null);
  const [pendingDifficulty, setPendingDifficulty] = useState<{
    level: DifficultyLevel;
    resumeOnCancel: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<DecisionEvent | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastPoint, setLastPoint] = useState<"human" | "ai" | null>(null);
  const phase = view?.phase ?? "ready";
  const difficulty = view?.difficulty ?? DEFAULT_DIFFICULTY;
  const difficultyProfile = DIFFICULTY_LEVELS[difficulty];
  const active = phase === "playing" || phase === "countdown";
  const hasPlayerName = playerName.trim().length > 0;
  const displayPlayerName = normalizePlayerName(playerName);
  const leaderboardCard = useMemo<ResultLeaderboardData>(() => {
    const personalBest = recording.result?.board.personalBest;
    if (personalBest)
      return {
        status: "ranked",
        rank: personalBest.rank,
        durationMs: personalBest.durationMs,
        totalPlayers: recording.result?.board.totalPlayers ?? 0,
        reason: null,
      };
    if (recording.status === "saved")
      return {
        status: "unranked",
        rank: null,
        durationMs: null,
        totalPlayers: recording.result?.board.totalPlayers ?? 0,
        reason: recording.result?.reason ?? null,
      };
    if (
      recording.status === "registering" ||
      recording.status === "playing" ||
      recording.status === "saving"
    )
      return {
        status: "pending",
        rank: null,
        durationMs: null,
        totalPlayers: 0,
        reason: null,
      };
    return {
      status: "unavailable",
      rank: null,
      durationMs: null,
      totalPlayers: 0,
      reason: null,
    };
  }, [recording]);
  const resultCardData = useMemo<ResultCardData>(
    () => ({
      playerName: displayPlayerName,
      humanScore: view?.score.human ?? 0,
      agentScore: view?.score.ai ?? 0,
      winner: view?.winner ?? null,
      longestRally: view?.longestRally ?? 0,
      decisions: metrics.accepted,
      fallbackRate: metrics.fallbackRate,
      latencyP50Ms: metrics.latencyP50Ms,
      model: latest?.decision.model ?? config?.model ?? "Jev",
      difficulty,
      leaderboard: leaderboardCard,
    }),
    [
      config?.model,
      displayPlayerName,
      difficulty,
      latest?.decision.model,
      leaderboardCard,
      metrics.accepted,
      metrics.fallbackRate,
      metrics.latencyP50Ms,
      view?.longestRally,
      view?.score.ai,
      view?.score.human,
      view?.winner,
    ],
  );

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new PongEngine();
    const renderer = new CourtRenderer(canvasRef.current);
    const audio = new ArcadeAudio();
    const recorder = new MatchRecorder({
      playerName: () => playerNameRef.current,
      onChange: setRecording,
    });
    const runtime: Runtime = {
      engine,
      renderer,
      audio,
      recorder,
      controller: null,
      session: new SessionTelemetry({ appVersion: "1.0.0" }),
    };
    runtimeRef.current = runtime;
    let disposed = false;
    let publicConfig: AgentPublicConfig | null = null;
    let configRetry: ReturnType<typeof setTimeout> | undefined;
    const configAbort = new AbortController();
    let frame = 0;
    let previous = performance.now();
    let lastPublish = 0;
    const resizeObserver = new ResizeObserver(() => renderer.resize());
    resizeObserver.observe(canvasRef.current);
    renderer.resize();
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      engine.update(dt);
      recorder.observe(
        engine.state,
        runtime.controller?.strategy ?? "balanced",
      );
      runtime.controller?.update(now);
      const events = engine.consumeEvents();
      for (const event of events) {
        if (event.type === "score") {
          setLastPoint(event.side ?? null);
          audio.play("point");
        } else if (
          event.type === "hit" ||
          event.type === "wall" ||
          event.type === "boost"
        )
          audio.play(event.type);
        else if (event.type === "finish") audio.play("win");
        else if (event.type === "countdown") audio.play("ready");
        else if (event.type === "serve") setLastPoint(null);
      }
      renderer.draw(engine.state, events, dt);
      if (now - lastPublish > 100) {
        lastPublish = now;
        setView(structuredClone(engine.state));
        setMetrics(runtime.session.getMetrics());
        setPending(runtime.controller?.telemetry.inFlight ?? false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const setup = async () => {
      try {
        const response = await fetch("/api/agent/config", {
          signal: AbortSignal.any([
            configAbort.signal,
            AbortSignal.timeout(3000),
          ]),
        });
        if (!response.ok) throw new Error("configuration");
        const resolved = agentPublicConfigSchema.parse(await response.json());
        if (disposed) return;
        publicConfig = resolved;
        setConfig(resolved);
        runtime.session.setPricing(resolved.pricing);
        runtime.controller?.configure({
          intervalMs: resolved.decisionIntervalMs,
          timeoutMs: resolved.requestTimeoutMs + 500,
        });
        runtime.controller?.resumeRequests();
      } catch {
        if (!disposed)
          configRetry = setTimeout(() => {
            void setup();
          }, 2000);
      }
    };
    runtime.controller = new DecisionController(engine, {
      intervalMs: 250,
      timeoutMs: 1400,
      requestDecision: async (
        state: AgentGameState,
        signal: AbortSignal,
      ): Promise<AgentDecisionResponse> => {
        if (!navigator.onLine) throw { fallbackReason: "offline" };
        if (!publicConfig)
          throw { fallbackReason: "configuration", retryAfterMs: 1000 };
        const response = await fetch("/api/agent/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state,
            ...(publicConfig.mockScenariosEnabled
              ? { scenario: scenarioRef.current }
              : {}),
          }),
          signal,
        });
        if (!response.ok)
          throw {
            fallbackReason:
              response.status === 429 ? "rate_limit" : "provider_error",
            retryAfterMs: 1000,
          };
        return (await response.json()) as AgentDecisionResponse;
      },
      onDecision: (decision, snapshot, applied, rawResponse) => {
        if (disposed) return;
        const observed =
          applied.source === "fallback" && decision.source !== "fallback"
            ? {
                ...decision,
                source: "fallback" as const,
                fallbackReason: "low_confidence" as const,
              }
            : decision;
        const event = runtime.session.record(
          snapshot,
          observed,
          rawResponse,
          applied,
        );
        recorder.decision(observed);
        setLatest(event);
        setHistory(runtime.session.getHistory());
      },
      onStale: (decision) => {
        runtime.session.recordStale(decision);
      },
    });
    void setup();
    const visibility = () => {
      if (document.hidden) engine.pause("hidden");
      else {
        previous = performance.now();
        if (
          engine.state.phase === "paused" &&
          engine.state.pauseReason === "hidden"
        )
          engine.resume();
      }
    };
    const offline = () => {
      runtime.controller?.suspendRequests("offline");
    };
    const online = () => {
      runtime.controller?.resumeRequests();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      disposed = true;
      configAbort.abort();
      clearTimeout(configRetry);
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      runtime.controller?.dispose();
      recorder.dispose();
      audio.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timeout);
  }, [toast]);

  const focusCourt = () => canvasRef.current?.focus({ preventScroll: true });
  const playPause = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // Browser audio starts after a user gesture. Play/Space is the first
    // meaningful gesture, so the default-on preference becomes audible here.
    runtime.audio.setEnabled(soundEnabledRef.current);
    const { engine } = runtime;
    if (engine.state.phase === "ready") {
      engine.start();
      if (window.innerWidth > 760 && window.innerHeight < 850)
        courtRef.current?.scrollIntoView({
          block: "center",
          behavior: "instant",
        });
    } else if (engine.state.phase === "finished") {
      engine.restart();
      runtimeRef.current?.controller?.reset();
      setLastPoint(null);
      setLatest(null);
    } else if (engine.state.phase === "paused") engine.resume();
    else engine.pause();
    focusCourt();
  }, []);
  const restart = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (
      ["playing", "countdown", "paused"].includes(runtime.engine.state.phase)
    ) {
      runtime.engine.pause();
      setModal("restart");
    } else {
      runtime.engine.restart();
      runtime.controller?.reset();
      setLastPoint(null);
      setLatest(null);
      focusCourt();
    }
  }, []);
  const changeDifficulty = (level: DifficultyLevel, startMatch = false) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.engine.setDifficulty(level);
    runtime.controller?.reset();
    if (startMatch) runtime.engine.start();
    setView(structuredClone(runtime.engine.state));
    setLastPoint(null);
    setLatest(null);
    setPending(false);
    setPendingDifficulty(null);
    setModal(null);
  };
  const selectDifficulty = (level: DifficultyLevel) => {
    const engine = runtimeRef.current?.engine;
    if (!engine || level === engine.state.difficulty) return;
    if (["playing", "countdown", "paused"].includes(engine.state.phase)) {
      setPendingDifficulty({
        level,
        resumeOnCancel: engine.state.phase !== "paused",
      });
      engine.pause();
      setModal("difficulty");
    } else changeDifficulty(level);
  };
  const cancelDifficultyChange = () => {
    if (pendingDifficulty?.resumeOnCancel) runtimeRef.current?.engine.resume();
    setPendingDifficulty(null);
    setModal(null);
  };
  const showHelp = () => {
    runtimeRef.current?.engine.pause();
    setModal("help");
  };
  const inspect = (event: DecisionEvent | null = latest) => {
    runtimeRef.current?.engine.pause();
    setSelected(event);
    setModal("inspect");
  };
  const exportSession = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const data = runtime.session.exportSession(
      {
        human: runtime.engine.state.score.human,
        agent: runtime.engine.state.score.ai,
      },
      runtime.engine.state.winner,
      {
        match: {
          ...GAME,
          ...runtime.engine.difficultyConfig,
          difficulty: runtime.engine.state.difficulty,
          difficultyProfile: runtime.engine.difficultyConfig,
        },
        model: config,
      },
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jev-pong-session-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("Session JSON exported");
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key.toLowerCase();
    if (["arrowup", "arrowdown", "w", "s", " ", "r"].includes(key))
      event.preventDefault();
    if (["arrowup", "w"].includes(key))
      runtimeRef.current?.engine.setKeyboardDirection(-1);
    if (["arrowdown", "s"].includes(key))
      runtimeRef.current?.engine.setKeyboardDirection(1);
    if (key === " " && !event.repeat) playPause();
    if (key === "r" && !event.repeat) restart();
  };
  const movePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch" && event.buttons === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (
      event.pointerType === "touch" &&
      event.clientX - rect.left > rect.width / 2 &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    runtimeRef.current?.engine.setHumanTarget(
      ((event.clientY - rect.top) / rect.height) * GAME.height,
    );
  };
  const boostProgress = (side: "human" | "ai") =>
    !view
      ? 1
      : Math.max(
          0,
          Math.min(
            1,
            1 -
              (view.paddles[side].boostReadyAt - view.elapsed) /
                GAME.boostCooldown,
          ),
        );
  const toggleSound = () => {
    const enabled = !sound;
    soundEnabledRef.current = enabled;
    setSound(enabled);
    runtimeRef.current?.audio.setEnabled(enabled);
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Jev Pong home">
          <span className="brand-icon">
            <i />
            <b />
            <i />
          </span>
          <span>
            jev<span className="brand-pong">pong</span>
          </span>
        </Link>
        <span className="header-caption">
          A SMALL GAME. A NEW KIND OF OPPONENT.
        </span>
        <div className="header-links">
          <a href="#leaderboard">
            <Trophy size={16} />
            <span>Leaderboard</span>
          </a>
          <button onClick={showHelp} aria-label="How to play">
            <HelpCircle size={16} />
            <span>How to play</span>
          </button>
          <a href="https://typesafe.ai" target="_blank" rel="noreferrer">
            Meet Jev <ArrowUpRight size={15} />
          </a>
        </div>
      </header>

      <main>
        <section className="page-intro">
          <div>
            <div className="eyebrow intro-eyebrow">
              <span className="tiny-square" /> THE REAL-TIME AI ARCADE
            </div>
            <h1>
              Human instinct.
              <br className="mobile-break" /> <span>Machine intelligence.</span>
            </h1>
            <p>A familiar game. An opponent you can see making decisions.</p>
          </div>
          <div className="edition">
            <span>PLAYER 01 vs. JEV</span>
            <b>One paddle. Seven points.</b>
          </div>
        </section>

        <div className="game-layout">
          <section className="game-column" aria-label="Pong game">
            <div className="difficulty-panel">
              <div className="difficulty-heading">
                <span className="eyebrow" id="difficulty-label">
                  JEV DIFFICULTY
                </span>
                <span className="difficulty-default">YOUR CALL.</span>
              </div>
              <div
                className="difficulty-options"
                role="group"
                aria-labelledby="difficulty-label"
                aria-describedby="difficulty-description"
              >
                {([1, 2, 3] as const).map((level) => {
                  const profile = DIFFICULTY_LEVELS[level];
                  return (
                    <button
                      key={level}
                      type="button"
                      aria-label={profile.label}
                      aria-pressed={difficulty === level}
                      onClick={() => selectDifficulty(level)}
                    >
                      <strong>{profile.label}</strong>
                      <span className="difficulty-indicator" aria-hidden="true">
                        {[1, 2, 3].map((step) => (
                          <i
                            key={step}
                            className={step <= level ? "filled" : ""}
                          />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p id="difficulty-description">{difficultyProfile.description}</p>
              <p className="leaderboard-notice">
                Playing logs your nickname and result when the leaderboard is
                connected. Completed matches with at least 70% live Jev
                decisions are ranked publicly.{" "}
                <a href="#leaderboard">Leaderboard rules</a>
              </p>
            </div>
            <div className="arena-panel panel" ref={courtRef}>
              <div className="panel-heading arena-heading">
                <div>
                  <Gamepad2 size={17} />
                  <span>THE ARENA</span>
                  <span className="arena-phase">
                    {phase === "ready"
                      ? "READY TO PLAY"
                      : phase === "finished"
                        ? "MATCH COMPLETE"
                        : phase === "paused"
                          ? "PAUSED"
                          : "MATCH IN PROGRESS"}
                  </span>
                  <time className="match-timer" aria-label="Match time">
                    {formatRaceTime((view?.elapsed ?? 0) * 1000)}
                  </time>
                </div>
                <div className="arena-actions">
                  <button
                    className={`icon-button ${sound ? "enabled" : ""}`}
                    onClick={toggleSound}
                    aria-label={sound ? "Mute sound" : "Enable sound"}
                    title={sound ? "Mute sound" : "Enable sound"}
                  >
                    {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen();
                      else
                        void courtRef.current
                          ?.requestFullscreen()
                          .catch(() =>
                            setToast(
                              "Fullscreen isn’t available in this browser",
                            ),
                          );
                    }}
                    aria-label="Toggle fullscreen"
                    title="Fullscreen"
                  >
                    <Expand size={16} />
                  </button>
                </div>
              </div>
              <div
                className="scoreboard"
                aria-label={`Score: ${hasPlayerName ? displayPlayerName : "You"} ${view?.score.human ?? 0}, Jev ${view?.score.ai ?? 0}`}
              >
                <div className="player-name human-name">
                  <span className="player-symbol human-symbol" />
                  <div>
                    <b title={hasPlayerName ? displayPlayerName : undefined}>
                      {hasPlayerName ? displayPlayerName : "YOU"}
                    </b>
                    <span>Human instinct</span>
                  </div>
                </div>
                <div className="scores">
                  <strong>
                    {String(view?.score.human ?? 0).padStart(2, "0")}
                  </strong>
                  <div>
                    <span>FIRST TO</span>
                    <b>7</b>
                  </div>
                  <strong className="ai-score">
                    {String(view?.score.ai ?? 0).padStart(2, "0")}
                  </strong>
                </div>
                <div className="player-name ai-name">
                  <div>
                    <b>
                      JEV{" "}
                      <span
                        className={`mini-source ${latest?.decision.source === "fallback" ? "warning" : ""}`}
                      >
                        {sourceName(
                          latest?.decision.source ??
                            (!config
                              ? "connecting"
                              : config.provider === "jev"
                                ? "jev"
                                : "mock"),
                        )}
                      </span>
                    </b>
                    <span className="active-difficulty">
                      {difficultyProfile.label}
                    </span>
                  </div>
                  <span className="player-symbol ai-symbol" />
                </div>
              </div>
              <div
                className={`court ${phase === "ready" || phase === "paused" || phase === "finished" ? "court-idle" : ""}`}
              >
                <canvas
                  ref={canvasRef}
                  tabIndex={0}
                  aria-label="Pong arena. Move your paddle with the mouse, touch, W and S, or up and down arrows. Space pauses. R restarts."
                  onKeyDown={onKeyDown}
                  onKeyUp={(event) => {
                    if (
                      ["arrowup", "arrowdown", "w", "s"].includes(
                        event.key.toLowerCase(),
                      )
                    ) {
                      event.preventDefault();
                      runtimeRef.current?.engine.setKeyboardDirection(0);
                    }
                  }}
                  onBlur={() =>
                    runtimeRef.current?.engine.setKeyboardDirection(0)
                  }
                  onPointerMove={movePointer}
                  onPointerDown={(event) => {
                    if (
                      event.pointerType === "touch" &&
                      event.nativeEvent.offsetX >
                        event.currentTarget.clientWidth / 2
                    )
                      return;
                    event.currentTarget.focus({ preventScroll: true });
                    event.currentTarget.setPointerCapture(event.pointerId);
                    movePointer(event);
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                  }}
                />
                {phase === "ready" && (
                  <div className="court-overlay ready-overlay">
                    <div className="ready-kicker">
                      <span /> EASY TO PLAY. HARD TO PUT DOWN.
                    </div>
                    <h2>
                      Meet your match<span>.</span>
                    </h2>
                    <p>
                      You bring the reflexes.
                      <br />
                      Jev brings the next move.
                    </p>
                    <label className="player-name-entry">
                      <span>YOUR NAME</span>
                      <input
                        value={playerName}
                        maxLength={18}
                        autoComplete="nickname"
                        aria-label="Player name"
                        placeholder="Player 01"
                        onChange={(event) => setPlayerName(event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") playPause();
                        }}
                      />
                    </label>
                    <button
                      className="primary-button play-button"
                      onClick={playPause}
                    >
                      <Play size={17} fill="currentColor" /> Let’s play{" "}
                      <ArrowRight size={17} />
                    </button>
                    <span className="start-hint">
                      Move your mouse. That’s the whole game.
                    </span>
                  </div>
                )}
                {phase === "countdown" && (
                  <div
                    className="court-overlay countdown-overlay"
                    aria-live="polite"
                  >
                    <span className="eyebrow">
                      {lastPoint
                        ? lastPoint === "human"
                          ? "NICE ONE. YOUR POINT."
                          : "JEV’S POINT. YOU’VE GOT THIS."
                        : "GET READY"}
                    </span>
                    <strong key={Math.ceil(view?.countdown ?? 3)}>
                      {Math.max(1, Math.ceil(view?.countdown ?? 3))}
                    </strong>
                    <span>Move your paddle to get a feel for it.</span>
                  </div>
                )}
                {phase === "paused" && (
                  <div className="court-overlay pause-overlay">
                    <span className="overlay-icon">
                      <Pause size={22} />
                    </span>
                    <h2>Take a breather.</h2>
                    <p>Your next point is waiting.</p>
                    <button className="primary-button" onClick={playPause}>
                      <Play size={16} fill="currentColor" /> Keep playing
                    </button>
                    <span className="start-hint">or press space</span>
                  </div>
                )}
                {phase === "finished" && (
                  <div className="court-overlay finish-overlay">
                    <span className="overlay-icon trophy">
                      <Trophy size={27} />
                    </span>
                    <span className="eyebrow">
                      {view?.winner === "human"
                        ? "HUMAN INSTINCT WINS"
                        : "A GOOD GAME. A BETTER REMATCH?"}
                    </span>
                    <h2>
                      {view?.winner === "human"
                        ? `${hasPlayerName ? displayPlayerName : "You"} beat Jev.`
                        : `${hasPlayerName ? displayPlayerName : "Jev"}${hasPlayerName ? ", Jev takes this one." : " takes this one."}`}
                    </h2>
                    <p>
                      {difficultyProfile.label} ·{" "}
                      {formatRaceTime((view?.elapsed ?? 0) * 1000)}
                      <br />
                      {leaderboardCard.status === "ranked" ? (
                        <>
                          Current rank #{leaderboardCard.rank} · Personal best{" "}
                          {leaderboardCard.durationMs === null
                            ? ""
                            : formatRaceTime(leaderboardCard.durationMs)}
                        </>
                      ) : leaderboardCard.status === "pending" ? (
                        "Saving leaderboard result…"
                      ) : (
                        <>
                          Best rally: {view?.longestRally ?? 0} hits ·{" "}
                          {metrics.accepted} decisions this session
                        </>
                      )}
                    </p>
                    <div className="finish-actions">
                      <button
                        className="primary-button"
                        onClick={() => setModal("share")}
                      >
                        <Share2 size={17} /> Share your result
                      </button>
                      <button className="secondary-button" onClick={playPause}>
                        <RotateCcw size={16} /> One more round
                      </button>
                    </div>
                    <button className="subtle-button" onClick={exportSession}>
                      <Download size={14} /> Export this session
                    </button>
                  </div>
                )}
                {phase === "playing" && view && view.rally >= 4 && (
                  <div
                    className={`rally-badge ${view.rally >= 10 ? "hot-rally" : ""}`}
                  >
                    <Sparkles size={13} />
                    {view.rally} HIT RALLY
                  </div>
                )}
              </div>
              <div className="court-footer">
                <div className="energy-group">
                  <Zap size={13} />
                  <span>AUTO BOOST</span>
                  <div className="energy-meter">
                    <i
                      style={{ transform: `scaleX(${boostProgress("human")})` }}
                    />
                  </div>
                  <b>{boostProgress("human") >= 1 ? "READY" : "CHARGING"}</b>
                </div>
                <div className="energy-group ai-energy">
                  <b>{boostProgress("ai") >= 1 ? "READY" : "CHARGING"}</b>
                  <div className="energy-meter">
                    <i
                      style={{ transform: `scaleX(${boostProgress("ai")})` }}
                    />
                  </div>
                  <span>JEV BOOST</span>
                  <Zap size={13} />
                </div>
              </div>
            </div>
            <div className="controls-bar">
              <div className="control-hints">
                <span className="pointer-hint">
                  <MousePointer2 size={15} /> Move to play
                </span>
                <span className="keyboard-hint">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd>
                  <span>or</span>
                  <kbd>W</kbd>
                  <kbd>S</kbd>
                </span>
                <span className="touch-hint">Drag your half to move</span>
              </div>
              <div className="playback-controls">
                <button
                  onClick={playPause}
                  aria-label={
                    active
                      ? "Pause match"
                      : phase === "ready"
                        ? "Start match"
                        : phase === "finished"
                          ? "Play again"
                          : "Resume match"
                  }
                >
                  {active ? <Pause size={14} /> : <Play size={14} />}
                  <span>
                    {active
                      ? "Pause"
                      : phase === "ready"
                        ? "Play"
                        : phase === "finished"
                          ? "Again"
                          : "Resume"}
                  </span>
                  <kbd>SPACE</kbd>
                </button>
                <button
                  onClick={restart}
                  aria-label="Restart match"
                  title="Restart match"
                >
                  <RotateCcw size={15} />
                </button>
              </div>
            </div>
            <div className="game-caption">
              <span>
                <span className="signal-dot" /> Simple controls. Every decision
                in the open.
              </span>
              <span>
                BEST RALLY{" "}
                <b>{String(view?.longestRally ?? 0).padStart(2, "0")}</b>
              </span>
            </div>
            {phase !== "finished" && recording.status === "unavailable" && (
              <p className="match-recording-notice" role="status">
                {recording.message}
              </p>
            )}
            {phase === "finished" && (
              <LeaderboardResult
                recording={recording}
                onRetry={() => runtimeRef.current?.recorder.retry()}
              />
            )}
          </section>

          <DecisionMonitor
            decision={latest?.decision ?? null}
            snapshot={latest?.snapshot ?? null}
            metrics={metrics}
            config={config}
            pending={pending}
            playing={active}
            explanation={
              latest
                ? explainDecision(
                    latest.snapshot,
                    latest.decision,
                    latest.appliedAction,
                  )
                : null
            }
            currentMovement={
              view?.phase === "playing"
                ? view.movement
                : latest?.appliedAction?.movement
            }
            currentShotTarget={
              view?.phase === "playing"
                ? view.shotTarget
                : latest?.appliedAction?.shotTarget
            }
            onInspect={() => inspect()}
          />
        </div>

        <Leaderboard latestResult={recording.result} />

        <section className="session-section" aria-label="Decision history">
          <div className="session-heading">
            <div>
              <span className="eyebrow">THE PLAY-BY-PLAY</span>
              <h2>Every move has a receipt.</h2>
            </div>
            <div className="session-actions">
              <label className="strategy-select">
                AGENT STYLE
                <select
                  value={strategy}
                  aria-label="Agent strategy"
                  onChange={(event) => {
                    const value = event.target.value as Strategy;
                    setStrategy(value);
                    if (runtimeRef.current?.controller)
                      runtimeRef.current.controller.strategy = value;
                    if (runtimeRef.current)
                      runtimeRef.current.recorder.observe(
                        runtimeRef.current.engine.state,
                        value,
                      );
                  }}
                >
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="defensive">Defensive</option>
                </select>
                <ChevronDown size={13} />
              </label>
              <button
                className="secondary-button export-button"
                onClick={exportSession}
              >
                <Download size={15} />
                <span>Export session</span>
              </button>
            </div>
          </div>
          <details className="history-disclosure">
            <summary>
              <span>
                <span className="history-count">
                  {String(history.length).padStart(2, "0")}
                </span>{" "}
                Recent decisions <span className="muted">· latest 50</span>
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="history-table-wrap">
              {history.length ? (
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>SESSION TIME</th>
                      <th>MOVEMENT</th>
                      <th>RETURN</th>
                      <th>CONFIDENCE</th>
                      <th>LATENCY</th>
                      <th>SOURCE</th>
                      <th>
                        <span className="sr-only">Inspect</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((event) => (
                      <tr key={event.id}>
                        <td>{(event.atMs / 1000).toFixed(1)}s</td>
                        <td>
                          <span className="history-movement">
                            {event.decision.movement === "UP" ? (
                              <ArrowUp size={13} />
                            ) : event.decision.movement === "DOWN" ? (
                              <ArrowDown size={13} />
                            ) : (
                              <span>—</span>
                            )}
                            {event.decision.movement}
                          </span>
                        </td>
                        <td>{event.decision.returnStyle}</td>
                        <td>
                          {Math.round(event.decision.movementConfidence * 100)}%
                        </td>
                        <td>
                          {event.decision.timing.roundTripMs == null
                            ? "—"
                            : `${Math.round(event.decision.timing.roundTripMs)} ms`}
                        </td>
                        <td>
                          <span
                            className={`source-badge ${event.decision.source}`}
                            title={event.decision.fallbackReason}
                          >
                            {sourceName(event.decision.source)}
                          </span>
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            onClick={() => inspect(event)}
                            aria-label={`Inspect decision ${event.decision.sequence}`}
                          >
                            <Braces size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="history-empty">
                  <ActivityMark />
                  <p>Play a round. Watch the decisions roll in.</p>
                  <span>
                    Movement, confidence, and timing — all captured here.
                  </span>
                </div>
              )}
            </div>
          </details>
          <details className="developer-tools">
            <summary>
              <Braces size={13} /> Developer tools <ChevronDown size={12} />
            </summary>
            <div className="developer-content">
              <p>
                Snapshots use logical pixels and pixels per second. Model
                choices, confidence gates, and collision physics compose the
                final action.
              </p>
              <button className="secondary-button" onClick={() => inspect()}>
                <Braces size={14} /> Open raw inspector
              </button>
              {config?.mockScenariosEnabled && (
                <label>
                  Simulate a provider issue
                  <select
                    value={scenario}
                    aria-label="Mock failure scenario"
                    onChange={(event) => {
                      const value = event.target.value as MockScenario;
                      setScenario(value);
                      scenarioRef.current = value;
                      runtimeRef.current?.controller?.resumeRequests();
                    }}
                  >
                    <option value="normal">Normal operation</option>
                    <option value="timeout">Timeout</option>
                    <option value="rate_limit">Rate limit</option>
                    <option value="provider_error">Provider error</option>
                    <option value="low_confidence">Low confidence</option>
                    <option value="invalid_response">Invalid response</option>
                  </select>
                </label>
              )}
              <p className="privacy-note">
                Session data stays in this tab. No analytics. Mock token counts
                are simulated and incur no API cost.
              </p>
            </div>
          </details>
        </section>
      </main>
      <footer className="site-footer">
        <span>BUILT TO PLAY. MADE TO SHOW WHAT’S POSSIBLE.</span>
        <nav className="footer-links" aria-label="Project links">
          <a href="https://typesafe.ai" target="_blank" rel="noreferrer">
            Powered by <b>TypeSafe</b>
            <ArrowUpRight size={13} />
          </a>
          <a
            href="https://app.fabricgateway.ai?utm_source=jevpong"
            target="_blank"
            rel="noreferrer"
          >
            Powered by <b>Postman Fabric Gateway</b>
            <ArrowUpRight size={13} />
          </a>
          <a
            href="https://github.com/Postman-Devrel/JevPong"
            target="_blank"
            rel="noreferrer"
          >
            <GitFork size={13} />
            <b>Fork on GitHub</b>
            <ArrowUpRight size={13} />
          </a>
        </nav>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {modal === "help" && (
        <Modal
          title="Just move. You’re already playing."
          onClose={() => setModal(null)}
        >
          <p className="modal-description">
            You’re the paddle on the left. Send the ball past Jev. First to
            seven takes the match.
          </p>
          <div className="help-controls">
            <div>
              <MousePointer2 size={23} />
              <h3>Mouse or touch</h3>
              <p>
                Move your pointer up and down. On a phone, drag on your half of
                the court.
              </p>
            </div>
            <div>
              <Keyboard size={23} />
              <h3>More of a keyboard person?</h3>
              <p>
                Use ↑ / ↓ or W / S. Space pauses. R restarts. Click the court to
                focus it.
              </p>
            </div>
            <div>
              <Zap size={23} />
              <h3>A little extra kick</h3>
              <p>
                Your boost charges automatically. Strong edge hits give the ball
                extra pace. No extra buttons.
              </p>
            </div>
            <div>
              <Gamepad2 size={23} />
              <h3>Choose your challenge</h3>
              <p>
                Start on Hard for Jev’s toughest game, or choose Medium or Easy
                above the court. Changing difficulty during a match starts a
                fresh score. Agent style is a separate choice.
              </p>
            </div>
          </div>
          <div className="honesty-note">
            <b>A game you can look inside.</b>
            <p>
              The monitor shows structured choices and measured timing.{" "}
              {!config
                ? "The connection is being checked. A labelled fallback keeps the match playable if the server is unavailable."
                : config.provider === "jev"
                  ? "Live decisions come from the official TypeSafe API."
                  : "This demo is currently in mock mode. A simulated agent controls the paddle; no live Jev requests are made."}
            </p>
          </div>
          <button
            className="primary-button modal-primary"
            onClick={() => {
              setModal(null);
              runtimeRef.current?.audio.setEnabled(soundEnabledRef.current);
              const e = runtimeRef.current?.engine;
              if (e?.state.phase === "ready") e.start();
              else if (e?.state.phase === "paused") e.resume();
              focusCourt();
            }}
          >
            Got it. Let’s play <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {modal === "restart" && (
        <Modal title="A fresh start?" onClose={() => setModal(null)}>
          <p className="modal-description">
            This resets the current score. Your session’s decision history stays
            available.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => {
                setModal(null);
                runtimeRef.current?.engine.resume();
                focusCourt();
              }}
            >
              Keep this match
            </button>
            <button
              className="primary-button"
              onClick={() => {
                runtimeRef.current?.engine.restart();
                runtimeRef.current?.controller?.reset();
                setLastPoint(null);
                setLatest(null);
                setModal(null);
                focusCourt();
              }}
            >
              <RotateCcw size={16} /> Restart match
            </button>
          </div>
        </Modal>
      )}
      {modal === "difficulty" && pendingDifficulty && (
        <Modal title="Change difficulty?" onClose={cancelDifficultyChange}>
          <p className="modal-description">
            Start a new match on{" "}
            {DIFFICULTY_LEVELS[pendingDifficulty.level].label}? This resets the
            current score. Your session’s decision history stays available.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={cancelDifficultyChange}
            >
              Keep this match
            </button>
            <button
              className="primary-button"
              onClick={() => {
                changeDifficulty(pendingDifficulty.level, true);
                focusCourt();
              }}
            >
              <RotateCcw size={16} /> Restart on{" "}
              {DIFFICULTY_LEVELS[pendingDifficulty.level].label}
            </button>
          </div>
        </Modal>
      )}
      {modal === "inspect" && (
        <RawInspector event={selected} onClose={() => setModal(null)} />
      )}
      {modal === "share" && (
        <ResultShareModal
          data={resultCardData}
          onClose={() => setModal(null)}
          onToast={setToast}
        />
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {phase === "finished"
          ? `${view?.winner === "human" ? "You win" : "Jev wins"}.`
          : ""}{" "}
        Score: You {view?.score.human ?? 0}, Jev {view?.score.ai ?? 0}.
        Difficulty: {difficultyProfile.label}.
      </div>
    </div>
  );
}

function ActivityMark() {
  return (
    <span className="activity-mark">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
