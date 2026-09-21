import { z } from "zod";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  type Questions,
} from "@typesafe-ai/sdk";
import type { AgentDecision, AgentGameState } from "../contracts";
import {
  decisionIdentity,
  parseRetryAfter,
  ProviderError,
  type AgentProvider,
  type ProviderContext,
  type ProviderResult,
} from "./provider";
import { TYPESAFE_API_BASE_URL } from "./config";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Verified against https://docs.typesafe.ai/api on 2026-09-21. Never client supplied. */
export const JEV_QUESTIONS = Object.freeze({
  movement: {
    type: "choice",
    instructions:
      "Which movement gives the agent the best chance of intercepting the ball while avoiding unnecessary movement? The agent is the right paddle. Coordinates are logical pixels, with y increasing downward and velocities in pixels per second. The predicted intercept includes wall reflections. Consider the prediction, paddle height, motion, and measured latency. When the ball travels away, favor recovering toward the arena center.",
    criteria: {
      UP: "Move the paddle upward for the next action window.",
      DOWN: "Move the paddle downward for the next action window.",
      HOLD: "Keep the current vertical position for the next action window.",
    },
  },
  return_style: {
    type: "choice",
    instructions:
      "Which return style best matches the current game state and the agent strategy? Assume the agent makes contact on its next return. Evaluate this choice independently of movement.",
    criteria: {
      SAFE: "Prioritize a reliable return with normal speed and a conservative angle.",
      ANGLED:
        "Attempt a sharper vertical angle to make the return harder for the opponent.",
      FAST: "Attempt a faster return to put the opponent under immediate pressure.",
    },
  },
  use_boost: {
    type: "noul",
    instructions:
      "Given the complete state, should the agent spend its boost on the next eligible movement action? A boost briefly increases paddle movement speed. Consider whether boost is ready, the distance to intercept, time to impact, and uncertainty.",
    criteria: {
      true: "Boost is ready and extra movement speed is needed to intercept the approaching ball.",
      false:
        "Boost is unavailable or normal movement speed is sufficient; conserve boost.",
    },
  },
} satisfies Questions);

const probability = z.number().finite().min(0).max(1);
const movementAnswer = z.object({
  type: z.literal("choice"),
  choice: z.enum(["UP", "DOWN", "HOLD"]),
  confidence: probability,
  probabilities: z
    .object({ UP: probability, DOWN: probability, HOLD: probability })
    .strict(),
});
const returnAnswer = z.object({
  type: z.literal("choice"),
  choice: z.enum(["SAFE", "ANGLED", "FAST"]),
  confidence: probability,
  probabilities: z
    .object({ SAFE: probability, ANGLED: probability, FAST: probability })
    .strict(),
});
export const typeSafeResponseSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(100)
    .regex(/^jev-[a-zA-Z0-9.-]+$/),
  answers: z.object({
    movement: movementAnswer,
    return_style: returnAnswer,
    use_boost: z.object({ type: z.literal("noul"), noul: probability }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().max(10_000_000),
    output_tokens: z.number().int().nonnegative().max(10_000_000),
  }),
});
export type TypeSafeResponse = z.infer<typeof typeSafeResponseSchema>;

function validDistribution(answer: {
  choice: string;
  probabilities: Record<string, number>;
}): boolean {
  const values = Object.values(answer.probabilities);
  return (
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.015 &&
    answer.probabilities[answer.choice] >= Math.max(...values) - 0.00001
  );
}

export function normalizeJevResponse(
  raw: unknown,
  state: AgentGameState,
  requestId: string,
  serverMs = 0,
): ProviderResult {
  const parsed = typeSafeResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError("invalid_response");
  const response = parsed.data;
  const { movement, return_style: style, use_boost: boost } = response.answers;
  if (!validDistribution(movement) || !validDistribution(style))
    throw new ProviderError("invalid_response");
  const decision: AgentDecision = {
    ...decisionIdentity(state, requestId),
    movement: movement.choice,
    movementProbabilities: movement.probabilities,
    movementConfidence: movement.confidence,
    returnStyle: style.choice,
    returnStyleProbabilities: style.probabilities,
    returnStyleConfidence: style.confidence,
    useBoostProbability: boost.noul,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      billable: true,
    },
    timing: { serverMs, providerMs: null, roundTripMs: null },
    source: "jev",
  };
  // Zod strips unknown upstream fields. Never return headers, error bodies, or arbitrary provider metadata.
  return { decision, rawResponse: response };
}

export interface JevProviderOptions {
  apiKey: string;
  baseURL?: string;
  gatewayApiKey?: string;
  model: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

/** Limit response bodies, discard upstream error details, and enforce the selected auth boundary. */
function boundedTransport(fetcher: typeof fetch, gatewayManagedAuth: boolean) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const requestInit: RequestInit = { ...init, cache: "no-store" };
    if (gatewayManagedAuth) {
      const headers = new Headers(init?.headers);
      headers.delete("Authorization");
      requestInit.headers = headers;
    }
    const response = await fetcher(url, requestInit);
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const name of ["retry-after", "retry-after-ms"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!response.ok) {
      // Do not retain an upstream error body in an SDK Error, logs, or a response.
      void response.body?.cancel().catch(() => {});
      return new Response(null, { status: response.status, headers });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("invalid_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    init?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      init?.signal?.throwIfAborted();
      while (true) {
        const { value, done } = await reader.read();
        init?.signal?.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          cancel();
          throw new ProviderError("invalid_response");
        }
        chunks.push(value);
      }
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(data, { status: response.status, headers });
    } finally {
      init?.signal?.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };
}

function retryWindow(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (
    milliseconds !== null &&
    Number.isFinite(Number(milliseconds)) &&
    Number(milliseconds) >= 0
  )
    return Math.ceil(Number(milliseconds));
  return parseRetryAfter(headers.get("retry-after"));
}

export class JevProvider implements AgentProvider {
  constructor(private readonly options: JevProviderOptions) {}

  async decide(
    state: AgentGameState,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const gatewayManagedAuth = Boolean(this.options.gatewayApiKey);
    if (!this.options.apiKey && !gatewayManagedAuth)
      throw new ProviderError("missing_credentials", undefined, true);
    const started = performance.now();
    try {
      const client = new TypeSafeClient({
        // The SDK requires a value and always creates Authorization. Gateway
        // transport removes that header before dispatch, so no upstream key is sent.
        apiKey: gatewayManagedAuth
          ? "gateway-managed-auth"
          : this.options.apiKey,
        // Always explicit so SDK environment overrides cannot redirect credentials.
        baseURL: this.options.baseURL ?? TYPESAFE_API_BASE_URL,
        defaultHeaders: this.options.gatewayApiKey
          ? { "X-Gateway-key": this.options.gatewayApiKey }
          : undefined,
        defaultModel: this.options.model,
        timeout: this.options.timeoutMs,
        retry: { maxRetries: 0 },
        logLevel: "off",
        fetch: boundedTransport(
          this.options.fetcher ?? fetch,
          gatewayManagedAuth,
        ),
      });
      const raw = await client.systemOne(
        { model: this.options.model, state, questions: JEV_QUESTIONS },
        { signal: context.signal },
      );
      return normalizeJevResponse(
        raw,
        state,
        context.requestId,
        performance.now() - started,
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (
        error instanceof APITimeoutError ||
        error instanceof APIUserAbortError ||
        context.signal?.aborted
      )
        throw new ProviderError("timeout");
      if (error instanceof APIError) {
        const retryAfter = retryWindow(error.headers);
        if (error.status === 401 || error.status === 403)
          throw new ProviderError("authentication", undefined, true);
        if (
          error.status === 400 ||
          error.status === 404 ||
          error.status === 422
        )
          throw new ProviderError("configuration", undefined, true);
        if (error.status === 429)
          throw new ProviderError("rate_limit", retryAfter ?? 1_000);
        throw new ProviderError(
          "provider_error",
          retryAfter ?? (error.status >= 500 ? 500 : undefined),
        );
      }
      if (
        error instanceof APIConnectionError &&
        error.cause instanceof ProviderError
      )
        throw error.cause;
      throw new ProviderError("provider_error", 500);
    }
  }
}
