import { describe, expect, it } from "vitest";
import { createLeaderboardHandlers } from "../../lib/leaderboard/server";
import { sheetStore } from "../fixtures/leaderboard-store";

const SECRET = "test-secret-".repeat(5);
function fixture(provider = "jev") {
  const store = sheetStore(SECRET);
  let now = 1800000000000;
  const env = {
    GOOGLE_SHEETS_LEADERBOARD_URL:
      "https://script.google.com/macros/s/test-deployment/exec",
    LEADERBOARD_SECRET: SECRET,
    JEV_PROVIDER: provider,
    TYPESAFE_API_KEY: "fake-upstream-key",
  };
  const handler = createLeaderboardHandlers({
    env,
    fetcher: store.fetcher,
    now: () => now,
  });
  const request = (path: string, body?: unknown, cookie = "") =>
    new Request(`http://localhost:3000/api/leaderboard${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        cookie,
        origin: "http://localhost:3000",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  let sequence = 0;
  async function start(
    cookie = "",
    difficulty = 3,
    strategy = "balanced",
    playerName = "Ada",
  ) {
    const response = await handler.START(
      request(
        "/start",
        {
          clientMatchId: `test-${++sequence}`,
          playerName,
          difficulty,
          strategy,
        },
        cookie,
      ),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    return {
      ...data,
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie,
    } as { ticket: string; matchId: string; cookie: string };
  }
  async function finish(match: { ticket: string; cookie: string }, extra = {}) {
    now += 90000;
    return handler.FINISH(
      request(
        "/finish",
        {
          ticket: match.ticket,
          durationMs: 50000,
          humanScore: 7,
          aiScore: 0,
          liveDecisions: 40,
          fallbackDecisions: 0,
          mockDecisions: 0,
          strategyChanged: false,
          ...extra,
        },
        match.cookie,
      ),
    );
  }
  return {
    store,
    handler,
    start,
    finish,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("leaderboard API and storage adapters", () => {
  it("is explicitly unavailable without configuration and keeps secrets server-side", async () => {
    const handler = createLeaderboardHandlers({ env: {} });
    const response = await handler.GET(
      new Request("http://localhost/api/leaderboard"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "leaderboard_not_configured",
    });
  });
  it("logs start and finish in one row, returns a rank, and saves retries exactly once", async () => {
    const f = fixture();
    const match = await f.start();
    expect(f.store.rows).toHaveLength(2);
    expect(f.store.rows[1][8]).toBe("started");
    const response = await f.finish(match);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      ranked: true,
      rank: 1,
      personalBest: true,
      durationMs: 50000,
    });
    expect(result.board).toMatchObject({ totalPlayers: 1, difficulty: 3 });
    expect(result.board.personalBest).toMatchObject({
      playerName: "Ada",
      rank: 1,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("playerId");
    expect(JSON.stringify(result)).not.toContain("test-sheet");
    expect((await f.finish(match)).status).toBe(200);
    expect(f.store.rows).toHaveLength(2);
    expect((await f.finish(match, { durationMs: 49000 })).status).toBe(409);
    expect(f.store.rows[1][10]).toBe(50000);
  });
  it("retains the fastest run per browser, shares ties, and separates levels", async () => {
    const f = fixture();
    const ada = await f.start();
    await f.finish(ada);
    const ben = await f.start("", 3, "balanced", "Ben");
    expect(await (await f.finish(ben)).json()).toMatchObject({ rank: 1 });
    const slower = await f.start(ada.cookie);
    const result = await (await f.finish(slower, { durationMs: 60000 })).json();
    expect(result).toMatchObject({ rank: 2, personalBest: false });
    expect(result.board.totalPlayers).toBe(2);
    expect(result.board.personalBest.durationMs).toBe(50000);
    const easy = await f.start(ada.cookie, 1);
    expect(
      await (await f.finish(easy, { durationMs: 30000 })).json(),
    ).toMatchObject({ rank: 1, board: { totalPlayers: 1, difficulty: 1 } });
    const board = await f.handler.GET(
      f.request("?difficulty=3", undefined, ada.cookie),
    );
    expect(
      (await board.json()).entries.map((entry: { rank: number }) => entry.rank),
    ).toEqual([1, 1]);
  });
  it.each([
    ["loss", "jev", { humanScore: 4, aiScore: 7 }],
    ["fallback play", "jev", { fallbackDecisions: 1 }],
    ["mock decisions", "jev", { mockDecisions: 1 }],
    ["strategy changes", "jev", { strategyChanged: true }],
    [
      "exactly 70% live decisions",
      "jev",
      { liveDecisions: 7, fallbackDecisions: 3 },
    ],
  ])("ranks a completed match with %s", async (_case, provider, extra) => {
    const f = fixture(provider);
    const result = await (await f.finish(await f.start(), extra)).json();
    expect(result).toMatchObject({
      ranked: true,
      rank: 1,
      reason: null,
      board: { totalPlayers: 1 },
    });
    expect(f.store.rows[1][8]).toBe("completed");
  });
  it.each([
    ["a mock provider", "mock", {}],
    ["zero live decisions", "jev", { liveDecisions: 0 }],
    [
      "less than 70% live decisions",
      "jev",
      { liveDecisions: 6, fallbackDecisions: 4 },
    ],
  ])(
    "logs but does not rank a completed match with %s",
    async (_case, provider, extra) => {
      const f = fixture(provider);
      const result = await (await f.finish(await f.start(), extra)).json();
      expect(result).toMatchObject({
        ranked: false,
        rank: null,
        reason: "insufficient_live_decisions",
        board: { totalPlayers: 0 },
      });
      expect(f.store.rows[1][8]).toBe("completed");
    },
  );
  it("ranks a match started on another strategy", async () => {
    const f = fixture();
    expect(
      await (await f.finish(await f.start("", 3, "aggressive"))).json(),
    ).toMatchObject({ ranked: true, rank: 1, reason: null });
  });
  it("binds tickets to identity, level and name and rejects impossible/expired results", async () => {
    const f = fixture();
    const match = await f.start();
    expect((await f.finish({ ...match, cookie: "" })).status).toBe(400);
    expect(
      (
        await f.finish({
          ...match,
          ticket: match.ticket.replace(
            /^./,
            match.ticket[0] === "a" ? "b" : "a",
          ),
        })
      ).status,
    ).toBe(400);
    expect((await f.finish(match, { durationMs: 10 })).status).toBe(400);
    expect((await f.finish(match, { humanScore: 7, aiScore: 7 })).status).toBe(
      400,
    );
    expect((await f.finish(match, { difficulty: 1 })).status).toBe(400);
    f.advance(3 * 60 * 60 * 1000);
    expect((await f.finish(match)).status).toBe(400);
    expect(f.store.rows[1][8]).toBe("started");
  });
  it("rejects cross-site writes, oversized input, bad levels and formula names", async () => {
    const f = fixture();
    const cross = new Request("http://localhost:3000/api/leaderboard/start", {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    });
    expect((await f.handler.START(cross)).status).toBe(403);
    expect((await f.handler.GET(f.request("?difficulty=9"))).status).toBe(400);
    const body = {
      clientMatchId: "match",
      difficulty: 3,
      strategy: "balanced",
      playerName: "=IMPORTXML()",
    };
    expect((await f.handler.START(f.request("/start", body))).status).toBe(400);
    expect(
      (
        await f.handler.START(
          f.request("/start", { ...body, playerName: "a".repeat(9000) }),
        )
      ).status,
    ).toBe(413);
    expect(f.store.rows).toHaveLength(1);
  });
  it("keeps abandoned runs out and respects moderation without exposing raw rows", async () => {
    const f = fixture();
    await f.start();
    const winner = await f.start();
    await f.finish(winner);
    f.store.rows[2][19] = true;
    const response = await f.handler.GET(
      f.request("?difficulty=3", undefined, winner.cookie),
    );
    expect(await response.json()).toMatchObject({
      entries: [],
      personalBest: null,
      totalPlayers: 0,
    });
  });
  it("requires the shared secret and fails cleanly when the sheet lock is busy", async () => {
    const f = fixture();
    expect(
      f.store.call({ secret: "wrong", action: "board", payload: {} }),
    ).toEqual({ ok: false, error: "unauthorized" });
    f.store.setBusy(true);
    expect((await f.handler.GET(f.request("?difficulty=3"))).status).toBe(503);
  });
  it("does not replace identity cookies on public reads", async () => {
    const f = fixture();
    const response = await f.handler.GET(f.request("?difficulty=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("keeps a personal best outside the top 20 and skips old seasons", () => {
    const store = sheetStore(SECRET);
    const completedAt = "2026-09-22T12:00:00.000Z";
    for (let i = 1; i <= 25; i++) {
      const playerId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const claim = {
        matchId: String(i).padStart(43, "a"),
        playerId,
        playerName: `Player ${i}`,
        difficulty: 3,
        version: "jev-pong-1",
        provider: "jev",
        strategy: "balanced",
        startedAt: 1800000000000,
      };
      expect(
        store.call({ secret: SECRET, action: "start", payload: claim }).ok,
      ).toBe(true);
      expect(
        store.call({
          secret: SECRET,
          action: "finish",
          payload: {
            ...claim,
            completedAt,
            durationMs: 50000 + i * 1000,
            humanScore: 7,
            aiScore: 0,
            liveDecisions: 30,
            fallbackDecisions: 0,
            mockDecisions: 0,
            strategyChanged: false,
            ranked: true,
            reason: null,
          },
        }).ok,
      ).toBe(true);
    }
    const payload = {
      difficulty: 3,
      version: "jev-pong-1",
      playerId: "00000000-0000-4000-8000-000000000025",
    };
    const board = store.call({ secret: SECRET, action: "board", payload }).data;
    expect(board.entries).toHaveLength(20);
    expect(board.totalPlayers).toBe(25);
    expect(board.personalBest).toMatchObject({ rank: 25, durationMs: 75000 });
    expect(
      store.call({
        secret: SECRET,
        action: "board",
        payload: { ...payload, version: "jev-pong-2" },
      }).data.totalPlayers,
    ).toBe(0);
  });
  it("registers duplicate starts idempotently once the identity is known", async () => {
    const f = fixture();
    const identity = await f.start();
    const input = {
      clientMatchId: "same-match",
      playerName: "Ada",
      difficulty: 3,
      strategy: "balanced",
    };
    const first = await f.handler.START(
      f.request("/start", input, identity.cookie),
    );
    f.advance(5000);
    const second = await f.handler.START(
      f.request("/start", input, identity.cookie),
    );
    expect(await second.json()).toEqual(await first.json());
    expect(f.store.rows).toHaveLength(3);
  });
  it("returns storage failures as 503 and rate limits excessive registrations", async () => {
    const unavailable = createLeaderboardHandlers({
      env: {
        GOOGLE_SHEETS_LEADERBOARD_URL:
          "https://script.google.com/macros/s/test/exec",
        LEADERBOARD_SECRET: SECRET,
      },
      fetcher: async () => Response.json({ invalid: true }),
    });
    expect(
      (await unavailable.GET(new Request("http://localhost/api/leaderboard")))
        .status,
    ).toBe(503);
    const f = fixture();
    for (let i = 0; i < 12; i++) await f.start();
    const response = await f.handler.START(
      f.request("/start", {
        clientMatchId: "limited",
        playerName: "Ada",
        difficulty: 3,
        strategy: "balanced",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });
  it("prefers Supabase, sends its secret only as an API key, and maps every RPC", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const apiKey = `sb_secret_${"s".repeat(40)}`;
    const board = {
      difficulty: 3,
      entries: [],
      totalPlayers: 0,
      personalBest: null,
      updatedAt: "2026-09-22T12:00:00.000Z",
    };
    const fetcher = (async (input, init = {}) => {
      const url = String(input);
      const body = JSON.parse(String(init.body));
      calls.push({ url, init, body });
      if (url.endsWith("/jev_leaderboard_board"))
        return Response.json({ ok: true, data: board });
      if (url.endsWith("/jev_leaderboard_start"))
        return Response.json({
          ok: true,
          data: {
            matchId: body.p_match_id,
            playerId: body.p_player_id,
            playerName: body.p_player_name,
            difficulty: body.p_difficulty,
            version: body.p_version,
            provider: body.p_provider,
            strategy: body.p_strategy,
            startedAt: body.p_started_at_ms,
          },
        });
      return Response.json({
        ok: true,
        data: {
          matchId: body.p_match_id,
          ranked: true,
          reason: null,
          rank: 1,
          personalBest: true,
          durationMs: body.p_duration_ms,
          board: {
            ...board,
            entries: [
              {
                matchId: body.p_match_id,
                playerName: body.p_player_name,
                rank: 1,
                durationMs: body.p_duration_ms,
                humanScore: body.p_human_score,
                aiScore: body.p_ai_score,
                completedAt: body.p_completed_at,
              },
            ],
            totalPlayers: 1,
          },
        },
      });
    }) as typeof fetch;
    let now = 1800000000000;
    const handler = createLeaderboardHandlers({
      env: {
        SUPABASE_URL: "https://jev-pong.supabase.co",
        SUPABASE_SECRET_KEY: apiKey,
        GOOGLE_SHEETS_LEADERBOARD_URL:
          "https://script.google.com/macros/s/legacy/exec",
        LEADERBOARD_SECRET: SECRET,
        JEV_PROVIDER: "jev",
        TYPESAFE_API_KEY: "fake-upstream-key",
      },
      fetcher,
      now: () => now,
    });
    const request = (path: string, body?: unknown, cookie = "") =>
      new Request(`http://localhost:3000/api/leaderboard${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          cookie,
          origin: "http://localhost:3000",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    expect((await handler.GET(request("?difficulty=3"))).status).toBe(200);
    const started = await handler.START(
      request("/start", {
        clientMatchId: "supabase-match",
        playerName: "Ada",
        difficulty: 3,
        strategy: "balanced",
      }),
    );
    expect(started.status).toBe(200);
    const cookie = started.headers.get("set-cookie")!.split(";")[0];
    const startData = (await started.json()) as {
      ticket: string;
      matchId: string;
    };
    now += 90000;
    const finished = await handler.FINISH(
      request(
        "/finish",
        {
          ticket: startData.ticket,
          durationMs: 50000,
          humanScore: 7,
          aiScore: 0,
          liveDecisions: 40,
          fallbackDecisions: 0,
          mockDecisions: 0,
          strategyChanged: false,
        },
        cookie,
      ),
    );
    expect(finished.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://jev-pong.supabase.co/rest/v1/rpc/jev_leaderboard_board",
      "https://jev-pong.supabase.co/rest/v1/rpc/jev_leaderboard_start",
      "https://jev-pong.supabase.co/rest/v1/rpc/jev_leaderboard_finish",
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("apikey")).toBe(apiKey);
      expect(headers.get("authorization")).toBeNull();
      expect(JSON.stringify(call.body)).not.toContain(SECRET);
    }
    expect(calls[0].body).toEqual({
      p_difficulty: 3,
      p_player_id: "00000000-0000-0000-0000-000000000000",
      p_version: "jev-pong-1",
    });
    expect(calls[2].body).toMatchObject({
      p_match_id: startData.matchId,
      p_player_name: "Ada",
      p_duration_ms: 50000,
      p_ranked: true,
      p_reason: null,
    });
  });
});
