import { describe, expect, it, vi } from "vitest";
import { agentGameStateSchema } from "../../lib/agent/contracts";
import {
  JevProvider,
  normalizeJevResponse,
  TYPESAFE_ENDPOINT,
} from "../../lib/agent/providers/jev";
import { MockProvider } from "../../lib/agent/providers/mock";
import {
  parseRetryAfter,
  ProviderError,
} from "../../lib/agent/providers/provider";
import {
  baseState,
  decisionFixtures,
  officialResponseFixture,
} from "../fixtures/agent-states";

describe("official Jev adapter", () => {
  it("normalizes the official typed response and echoes freshness identifiers", () => {
    const { decision } = normalizeJevResponse(
      officialResponseFixture,
      baseState,
      "request-1",
      84,
    );
    expect(decision).toMatchObject({
      source: "jev",
      movement: "UP",
      movementConfidence: 0.78,
      returnStyle: "SAFE",
      useBoostProbability: 0.12,
      model: "jev-1.13.0",
      sequence: 1,
      matchId: "fixture-match",
      roundId: 1,
      directionVersion: 1,
      usage: { inputTokens: 630, outputTokens: 65, billable: true },
      timing: { serverMs: 84, providerMs: null, roundTripMs: null },
    });
  });

  it("allowlists raw data, removing extra upstream fields and credentials", () => {
    const result = normalizeJevResponse(
      {
        ...officialResponseFixture,
        apiKey: "sensitive",
        headers: { Authorization: "Bearer sensitive" },
        environment: "sensitive",
      },
      baseState,
      "request-1",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it.each([
    { ...officialResponseFixture, answers: {} },
    {
      ...officialResponseFixture,
      usage: { input_tokens: -1, output_tokens: 20 },
    },
    { ...officialResponseFixture, model: "unexpected\nsecret" },
    {
      ...officialResponseFixture,
      answers: {
        ...officialResponseFixture.answers,
        movement: {
          ...officialResponseFixture.answers.movement,
          probabilities: { UP: 0.1, DOWN: 0.1, HOLD: 0.1 },
        },
      },
    },
    {
      ...officialResponseFixture,
      answers: {
        ...officialResponseFixture.answers,
        movement: {
          ...officialResponseFixture.answers.movement,
          choice: "DOWN",
        },
      },
    },
  ])("rejects a malformed upstream response", (raw) => {
    expect(() => normalizeJevResponse(raw, baseState, "request-1")).toThrow(
      ProviderError,
    );
  });

  it("uses the official HTTP endpoint and constructs all questions on the server", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(officialResponseFixture));
    const provider = new JevProvider({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 900,
      fetcher,
    });
    await provider.decide(baseState, { requestId: "request-1" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init?.body as string);
    expect(body.state).toEqual(baseState);
    expect(Object.keys(body.questions)).toEqual([
      "movement",
      "return_style",
      "use_boost",
    ]);
    expect(body.questions.use_boost.type).toBe("noul");
  });

  it("sends only the Gateway credential to a configured gateway", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(officialResponseFixture));
    const provider = new JevProvider({
      apiKey: "typesafe-key",
      baseURL: "https://gateway.example/",
      gatewayApiKey: "gateway-key",
      model: "jev-latest",
      timeoutMs: 900,
      fetcher,
    });
    await provider.decide(baseState, { requestId: "request-1" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://gateway.example/v1/systemone");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Gateway-key")).toBe("gateway-key");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("pins the official host and disables SDK logging even when environment overrides exist", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://untrusted.example");
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const logs = ["debug", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "debug").mockImplementation(() => {}),
    );
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(officialResponseFixture));
      await new JevProvider({
        apiKey: "test-key",
        model: "jev-latest",
        timeoutMs: 900,
        fetcher,
      }).decide(baseState, { requestId: "request-1" });
      expect(fetcher.mock.calls[0][0]).toBe(TYPESAFE_ENDPOINT);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      logs.forEach((log) => log.mockRestore());
      vi.unstubAllEnvs();
    }
  });

  it("bounds response size before the SDK buffers or parses it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(70_000)));
    const provider = new JevProvider({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 900,
      fetcher,
    });
    await expect(
      provider.decide(baseState, { requestId: "request-1" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("supports the SDK's millisecond Retry-After header without internal retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("secret", {
        status: 429,
        headers: { "retry-after-ms": "1250" },
      }),
    );
    const provider = new JevProvider({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 900,
      fetcher,
    });
    await expect(
      provider.decide(baseState, { requestId: "request-1" }),
    ).rejects.toMatchObject({ code: "rate_limit", retryAfterMs: 1_250 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "authentication", true],
    [403, "authentication", true],
    [422, "configuration", true],
    [429, "rate_limit", false],
    [529, "provider_error", false],
  ])(
    "normalizes status %s without upstream detail",
    async (status, code, disabled) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("secret-provider-error", {
          status: status as number,
          headers: { "Retry-After": "2" },
        }),
      );
      const provider = new JevProvider({
        apiKey: "test-key",
        model: "jev-latest",
        timeoutMs: 900,
        fetcher,
      });
      await expect(
        provider.decide(baseState, { requestId: "request-1" }),
      ).rejects.toMatchObject({ code, disabled });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("aborts an overdue upstream call", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const pending = new JevProvider({
        apiKey: "test-key",
        model: "jev-latest",
        timeoutMs: 90,
        fetcher,
      }).decide(baseState, { requestId: "request-1" });
      const check = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(95);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses numeric and HTTP date retry windows", () => {
    expect(parseRetryAfter("2.5", 0)).toBe(2_500);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1_000)).toBe(2_000);
    expect(parseRetryAfter("nonsense")).toBeUndefined();
  });
});

describe("deterministic demo provider", () => {
  const provider = new MockProvider({ seed: 42, latencyMs: 0, timeoutMs: 1 });

  it("keeps all representative fixtures within the input schema", () => {
    for (const state of Object.values(decisionFixtures))
      expect(agentGameStateSchema.safeParse(state).success).toBe(true);
  });

  it("returns repeatable probabilities and simulated, nonbillable usage", async () => {
    const first = await provider.decide(baseState, { requestId: "request-1" });
    const second = await provider.decide(baseState, { requestId: "request-2" });
    expect(first.decision.movementProbabilities).toEqual(
      second.decision.movementProbabilities,
    );
    expect(first.decision.source).toBe("mock");
    expect(first.decision.usage.billable).toBe(false);
    expect(first.rawResponse).toHaveProperty("simulated", true);
  });

  it.each([
    ["approachingAbove", "UP"],
    ["approachingBelow", "DOWN"],
    ["aligned", "HOLD"],
    ["movingAway", "DOWN"],
  ])("selects useful movement for %s", async (fixture, movement) => {
    const { decision } = await provider.decide(decisionFixtures[fixture], {
      requestId: "request-1",
    });
    expect(decision.movement).toBe(movement);
  });

  it("exercises low confidence without fabricating a live provider source", async () => {
    const result = await provider.decide(baseState, {
      requestId: "request-1",
      scenario: "low_confidence",
    });
    expect(result.decision.movementConfidence).toBeLessThan(0.35);
    expect(result.decision.source).toBe("mock");
  });

  it.each([
    "timeout",
    "rate_limit",
    "provider_error",
    "invalid_response",
  ] as const)("supports forced %s", async (scenario) => {
    await expect(
      provider.decide(baseState, { requestId: "request-1", scenario }),
    ).rejects.toMatchObject({ code: scenario });
  });

  it("never requests unavailable boost and reflects defensive strategy", async () => {
    expect(
      (
        await provider.decide(decisionFixtures.boostUnavailable, {
          requestId: "request-1",
        })
      ).decision.useBoostProbability,
    ).toBeLessThan(0.72);
    expect(
      (
        await provider.decide(decisionFixtures.defensive, {
          requestId: "request-1",
        })
      ).decision.returnStyle,
    ).toBe("SAFE");
  });

  it("distinguishes urgent available boost from unavailable boost", async () => {
    const available = await provider.decide(decisionFixtures.boostAvailable, {
      requestId: "request-1",
    });
    const unavailable = await provider.decide(
      decisionFixtures.boostUnavailable,
      { requestId: "request-2" },
    );
    expect(available.decision.useBoostProbability).toBeGreaterThanOrEqual(0.72);
    expect(unavailable.decision.useBoostProbability).toBeLessThan(0.72);
  });

  it("produces valid distributions across every representative fixture", async () => {
    for (const state of Object.values(decisionFixtures)) {
      const { decision } = await provider.decide(state, {
        requestId: "fixture-check",
      });
      expect(
        Object.values(decision.movementProbabilities).reduce((a, b) => a + b),
      ).toBeCloseTo(1);
      expect(
        Object.values(decision.returnStyleProbabilities).reduce(
          (a, b) => a + b,
        ),
      ).toBeCloseTo(1);
      expect(decision.usage.billable).toBe(false);
    }
  });
});
