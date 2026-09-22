import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getServerConfig } from "../agent/providers/config";
import { DEFAULT_DIFFICULTY, GAME } from "../game/constants";
import {
  boardSchema,
  finishMatchSchema,
  LEADERBOARD_VERSION,
  levelSchema,
  MAX_MATCH_MS,
  resultSchema,
  startMatchSchema,
} from "./contracts";

const COOKIE = "jev_player";
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const ticketSchema = startMatchSchema.omit({ clientMatchId: true }).extend({
  matchId: z.string(),
  playerId: z.string(),
  startedAt: z.number().int(),
  version: z.literal(LEADERBOARD_VERSION),
  provider: z.enum(["jev", "mock"]),
});
type Config = { url: string; secret: string };
type Environment = Readonly<Record<string, string | undefined>>;
type Options = {
  env?: Environment;
  fetcher?: typeof fetch;
  now?: () => number;
};
class LeaderboardError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
  ) {
    super(code);
  }
}

function configuration(env: Environment): Config {
  const secret = env.LEADERBOARD_SECRET?.trim() ?? "";
  const raw = env.GOOGLE_SHEETS_LEADERBOARD_URL?.trim() ?? "";
  if (!secret && !raw) throw new LeaderboardError("leaderboard_not_configured");
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port ||
      secret.length < 32
    )
      throw new Error();
    return { url: url.href, secret };
  } catch {
    throw new LeaderboardError("leaderboard_not_configured");
  }
}

function mac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function sign(value: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}
function verify(value: string, secret: string): unknown {
  const parts = value.split(".");
  if (parts.length !== 2) throw new LeaderboardError("invalid_ticket", 400);
  const [body, signature] = parts;
  const expected = mac(body, secret);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    throw new LeaderboardError("invalid_ticket", 400);
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new LeaderboardError("invalid_ticket", 400);
  }
}
function identity(request: Request, secret: string): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw || raw.length > 500) return null;
  try {
    return z.object({ player: z.string().uuid() }).parse(verify(raw, secret))
      .player;
  } catch {
    return null;
  }
}
function cookie(player: string, secret: string, request: Request): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return `${COOKIE}=${sign({ player }, secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}
function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const supplied = request.headers.get("origin");
  if (!supplied) return true;
  try {
    const origin = new URL(supplied).origin;
    const url = new URL(request.url);
    if (origin === url.origin) return true;
    const host = request.headers.get("host");
    const proto = request.headers.get("x-forwarded-proto");
    return (
      !!host &&
      /^[a-zA-Z0-9.:[\]-]+$/.test(host) &&
      origin ===
        `${proto === "https" || proto === "http" ? proto : url.protocol.slice(0, -1)}://${host}`
    );
  } catch {
    return false;
  }
}
async function readBody(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new LeaderboardError("unsupported_media_type", 415);
  if (!request.body) throw new LeaderboardError("invalid_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      throw new LeaderboardError("payload_too_large", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new LeaderboardError("invalid_request", 400);
  }
}

/** Server-only bridge. Google credentials never reach the browser. */
export function createLeaderboardHandlers(options: Options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const buckets = new Map<string, number[]>();
  const reads = new Map<string, { until: number; data: unknown }>();
  const pendingReads = new Map<string, Promise<unknown>>();
  function limit(request: Request, action: string) {
    // Per-instance safety net only. An edge/WAF limit is also required for launch.
    const address =
      request.headers
        .get("x-forwarded-for")
        ?.split(",")[0]
        ?.trim()
        .slice(0, 80) ?? "local";
    const key = mac(`${action}:${address}`, configuration(env).secret);
    const cutoff = now() - 60000;
    for (const [peer, times] of buckets)
      if (times.at(-1)! < cutoff) buckets.delete(peer);
    const times = (buckets.get(key) ?? []).filter((time) => time > cutoff);
    if (times.length >= (action === "board" ? 60 : 12) || buckets.size > 10000)
      throw new LeaderboardError("rate_limited", 429);
    times.push(now());
    buckets.set(key, times);
  }
  async function call(action: string, payload: unknown): Promise<unknown> {
    const config = configuration(env);
    const response = await fetcher(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.secret, action, payload }),
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new LeaderboardError("leaderboard_unavailable");
    const parsed = z
      .object({
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().optional(),
      })
      .safeParse(await response.json());
    if (!parsed.success) throw new LeaderboardError("leaderboard_unavailable");
    const result = parsed.data;
    if (!result.ok) {
      const conflict =
        result.error === "result_conflict" || result.error === "match_missing";
      throw new LeaderboardError(
        conflict ? result.error! : "leaderboard_unavailable",
        conflict ? 409 : 503,
      );
    }
    return result.data;
  }
  function storageData<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new LeaderboardError("leaderboard_unavailable");
    return result.data;
  }
  const guard =
    (handler: (request: Request) => Promise<Response>) =>
    async (request: Request) => {
      try {
        if (!sameOrigin(request))
          throw new LeaderboardError("forbidden_origin", 403);
        return await handler(request);
      } catch (error) {
        const known = error instanceof LeaderboardError;
        return Response.json(
          {
            error: known
              ? error.code
              : error instanceof z.ZodError
                ? "invalid_request"
                : "leaderboard_unavailable",
          },
          {
            status: known
              ? error.status
              : error instanceof z.ZodError
                ? 400
                : 503,
            headers: {
              ...headers,
              ...(known && error.status === 429 ? { "Retry-After": "60" } : {}),
            },
          },
        );
      }
    };
  return {
    GET: guard(async (request) => {
      const { secret } = configuration(env);
      const difficulty = levelSchema.parse(
        Number(
          new URL(request.url).searchParams.get("difficulty") ??
            DEFAULT_DIFFICULTY,
        ),
      );
      limit(request, "board");
      const playerId =
        identity(request, secret) ?? "00000000-0000-0000-0000-000000000000";
      const key = `${difficulty}:${playerId}`;
      const cached = reads.get(key);
      let data = cached && cached.until > now() ? cached.data : undefined;
      if (!data) {
        let pending = pendingReads.get(key);
        if (!pending) {
          pending = call("board", {
            difficulty,
            playerId,
            version: LEADERBOARD_VERSION,
          });
          pendingReads.set(key, pending);
        }
        try {
          data = storageData(boardSchema, await pending);
        } finally {
          pendingReads.delete(key);
        }
        if (reads.size > 500) reads.clear();
        reads.set(key, { data, until: now() + 10000 });
      }
      return Response.json(data, { headers });
    }),
    START: guard(async (request) => {
      const { secret } = configuration(env);
      limit(request, "start");
      const input = startMatchSchema.parse(await readBody(request));
      const existing = identity(request, secret);
      const playerId = existing ?? randomUUID();
      const matchId = mac(`match:${playerId}:${input.clientMatchId}`, secret);
      const agent = getServerConfig(env);
      const claims = {
        ...input,
        playerId,
        matchId,
        startedAt: now(),
        version: LEADERBOARD_VERSION,
        provider:
          agent.provider === "jev" && agent.configured
            ? ("jev" as const)
            : ("mock" as const),
      };
      const stored = storageData(ticketSchema, await call("start", claims));
      return Response.json(
        { ticket: sign(stored, secret), matchId },
        {
          headers: {
            ...headers,
            ...(!existing
              ? { "Set-Cookie": cookie(playerId, secret, request) }
              : {}),
          },
        },
      );
    }),
    FINISH: guard(async (request) => {
      const { secret } = configuration(env);
      limit(request, "finish");
      const input = finishMatchSchema.parse(await readBody(request));
      const claims = ticketSchema.parse(verify(input.ticket, secret));
      if (claims.playerId !== identity(request, secret))
        throw new LeaderboardError("invalid_ticket", 400);
      const age = now() - claims.startedAt;
      if (age < 0 || age > MAX_MATCH_MS + 300000)
        throw new LeaderboardError("expired_match", 400);
      const points = input.humanScore + input.aiScore;
      if (
        input.durationMs > age + 5000 ||
        input.durationMs < points * GAME.countdownSeconds * 1000
      )
        throw new LeaderboardError("invalid_duration", 400);
      const { ticket: _ticket, ...result } = input;
      void _ticket;
      const totalDecisions =
        input.liveDecisions + input.fallbackDecisions + input.mockDecisions;
      const hasRequiredLiveShare =
        claims.provider === "jev" &&
        totalDecisions > 0 &&
        input.liveDecisions * 10 >= totalDecisions * 7;
      const data = storageData(
        resultSchema,
        await call("finish", {
          ...claims,
          ...result,
          durationMs: Math.round(input.durationMs / 10) * 10,
          completedAt: new Date(now()).toISOString(),
          ranked: hasRequiredLiveShare,
          reason: hasRequiredLiveShare ? null : "insufficient_live_decisions",
        }),
      );
      reads.clear();
      return Response.json(data, { headers });
    }),
  };
}

export const leaderboardHandlers = createLeaderboardHandlers();
