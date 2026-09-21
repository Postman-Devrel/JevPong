import { createHash, randomUUID } from "node:crypto";
import {
  decisionRequestSchema,
  type AgentDecisionResponse,
  type AgentGameState,
  type FallbackReason,
} from "../contracts";
import { JevProvider } from "./jev";
import { MockProvider } from "./mock";
import { fallbackDecision, ProviderError } from "./provider";
import { getServerConfig, type ServerAgentConfig } from "./config";

const MAX_BODY_BYTES = 12_288;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}
interface ServiceState {
  buckets: Map<string, Bucket>;
  fingerprint: string;
  unavailable: {
    reason: FallbackReason;
    until: number;
    disabled: boolean;
  } | null;
}

/** Per-instance limits bound spend; deploy an edge/shared limiter for a public high-traffic demo. */
function takeToken(
  state: ServiceState,
  key: string,
  rate: number,
  capacity: number,
  now: number,
): number {
  const bucket = state.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  bucket.tokens = Math.min(
    capacity,
    bucket.tokens + (Math.max(0, now - bucket.updatedAt) * rate) / 1_000,
  );
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    state.buckets.set(key, bucket);
    return Math.ceil(((1 - bucket.tokens) * 1_000) / rate);
  }
  bucket.tokens -= 1;
  state.buckets.set(key, bucket);
  return 0;
}

function safeOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Allows same-origin navigation/server test tools without Origin.
  try {
    const requestUrl = new URL(request.url);
    const suppliedOrigin = new URL(origin).origin;
    if (suppliedOrigin === requestUrl.origin) return true;
    // Next's bind address can be 0.0.0.0 even when the browser used localhost.
    // Host is the public authority of this request; never accept a different
    // forwarded host supplied by a caller. TLS proxies supply the scheme only.
    const host = request.headers.get("host");
    if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return false;
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    const protocol =
      forwardedProtocol === "https" || forwardedProtocol === "http"
        ? `${forwardedProtocol}:`
        : requestUrl.protocol;
    return suppliedOrigin === new URL(`${protocol}//${host}`).origin;
  } catch {
    return false;
  }
}

async function readLimitedBody(request: Request): Promise<unknown> {
  const advertised = Number(request.headers.get("content-length") ?? 0);
  if (advertised > MAX_BODY_BYTES) throw new Error("payload_too_large");
  if (!request.body) throw new Error("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_request");
  }
}

function failure(
  state: AgentGameState,
  requestId: string,
  reason: FallbackReason,
  started: number,
  retryAfterMs?: number,
  disabled = false,
): Response {
  const payload: AgentDecisionResponse = {
    decision: fallbackDecision(
      state,
      requestId,
      reason,
      performance.now() - started,
    ),
    rawResponse: { error: { code: reason } },
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(disabled ? { disabled } : {}),
  };
  return Response.json(payload, {
    // A valid fallback is a successful application response; the reason is explicit.
    headers: {
      ...JSON_HEADERS,
      ...(retryAfterMs !== undefined
        ? {
            "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
          }
        : {}),
    },
  });
}

export interface DecisionServiceOptions {
  getConfig?: () => ServerAgentConfig;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createDecisionHandler(options: DecisionServiceOptions = {}) {
  const service: ServiceState = {
    buckets: new Map(),
    fingerprint: "",
    unavailable: null,
  };
  return async function handleDecision(request: Request): Promise<Response> {
    const started = performance.now();
    const requestId = randomUUID();
    if (!safeOrigin(request))
      return Response.json(
        { error: "forbidden_origin" },
        { status: 403, headers: JSON_HEADERS },
      );
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return Response.json(
        { error: "unsupported_media_type" },
        { status: 415, headers: JSON_HEADERS },
      );
    let body: unknown;
    try {
      body = await readLimitedBody(request);
    } catch (error) {
      const oversized =
        error instanceof Error && error.message === "payload_too_large";
      return Response.json(
        { error: oversized ? "payload_too_large" : "invalid_request" },
        { status: oversized ? 413 : 400, headers: JSON_HEADERS },
      );
    }
    const parsed = decisionRequestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers: JSON_HEADERS },
      );
    const { state, scenario } = parsed.data;
    const config = (options.getConfig ?? getServerConfig)();
    if (config.configurationError)
      return failure(
        state,
        requestId,
        "configuration",
        started,
        undefined,
        true,
      );
    if (scenario && scenario !== "normal" && !config.mockScenariosEnabled)
      return Response.json(
        { error: "scenario_unavailable" },
        { status: 400, headers: JSON_HEADERS },
      );

    const now = (options.now ?? Date.now)();
    if (service.buckets.size > 1_000) {
      for (const [key, bucket] of service.buckets)
        if (now - bucket.updatedAt > 60_000) service.buckets.delete(key);
    }
    // Never retain or export the IP; a short one-way hash only scopes this process's limiter.
    const address =
      request.headers
        .get("x-forwarded-for")
        ?.split(",")[0]
        ?.trim()
        .slice(0, 80) ?? "local";
    const peer = createHash("sha256")
      .update(address)
      .digest("hex")
      .slice(0, 16);
    const boundedPeer =
      service.buckets.has(peer) || service.buckets.size < 1_000
        ? peer
        : "overflow";
    const peerWait = takeToken(service, boundedPeer, 8, 12, now);
    const globalWait = takeToken(service, "global", 15, 30, now);
    if (peerWait || globalWait)
      return failure(
        state,
        requestId,
        "rate_limit",
        started,
        Math.max(peerWait, globalWait, 250),
      );

    const fingerprint = createHash("sha256")
      .update(
        `${config.provider}\0${config.model}\0${config.apiBaseURL}\0${config.apiKey}\0${config.gatewayApiKey}`,
      )
      .digest("hex");
    if (service.fingerprint !== fingerprint) {
      service.fingerprint = fingerprint;
      service.unavailable = null;
    }
    if (config.provider === "jev" && !config.configured)
      return failure(
        state,
        requestId,
        "missing_credentials",
        started,
        undefined,
        true,
      );
    if (config.provider === "jev" && service.unavailable) {
      const blocked = service.unavailable;
      if (blocked.disabled || blocked.until > now)
        return failure(
          state,
          requestId,
          blocked.reason,
          started,
          blocked.disabled ? undefined : blocked.until - now,
          blocked.disabled,
        );
      service.unavailable = null;
    }

    try {
      const provider =
        config.provider === "jev"
          ? new JevProvider({
              apiKey: config.apiKey,
              baseURL: config.apiBaseURL,
              gatewayApiKey: config.gatewayApiKey,
              model: config.model,
              timeoutMs: config.requestTimeoutMs,
              fetcher: options.fetcher,
            })
          : new MockProvider({
              seed: config.mockSeed,
              latencyMs: config.mockLatencyMs,
              timeoutMs: config.requestTimeoutMs,
            });
      const result = await provider.decide(state, {
        requestId,
        signal: request.signal,
        scenario,
      });
      result.decision.timing.serverMs = performance.now() - started;
      return Response.json(result, { headers: JSON_HEADERS });
    } catch (error) {
      const safe =
        error instanceof ProviderError
          ? error
          : new ProviderError("provider_error", 750);
      if (config.provider === "jev" && (safe.disabled || safe.retryAfterMs)) {
        service.unavailable = {
          reason: safe.code,
          until: (options.now ?? Date.now)() + (safe.retryAfterMs ?? 0),
          disabled: safe.disabled,
        };
      }
      // No in-request retries: in a real-time game an old decision is worse than a skipped one.
      return failure(
        state,
        requestId,
        safe.code,
        started,
        safe.retryAfterMs,
        safe.disabled,
      );
    }
  };
}
