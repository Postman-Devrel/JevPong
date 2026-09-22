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
      shotTarget: "LOWER",
      shotTargetProbabilities: { UPPER: 0.08, CENTER: 0.14, LOWER: 0.78 },
      shotTargetConfidence: 0.7,
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

  it("accepts legacy responses without fabricating a shot-placement decision", () => {
    const raw = structuredClone(officialResponseFixture);
    const answers = {
      movement: raw.answers.movement,
      return_style: raw.answers.return_style,
      use_boost: raw.answers.use_boost,
    };
    const result = normalizeJevResponse(
      { ...raw, answers },
      baseState,
      "legacy-response",
    );
    expect(result.decision.shotTarget).toBeUndefined();
    expect(result.decision.shotTargetProbabilities).toBeUndefined();
    expect(result.decision.shotTargetConfidence).toBeUndefined();
  });

  it.each([
    null,
    { type: "choice", choice: "LOWER" },
    { ...officialResponseFixture.answers.shot_target, choice: "OUTSIDE" },
    { ...officialResponseFixture.answers.shot_target, confidence: 1.1 },
    {
      ...officialResponseFixture.answers.shot_target,
      probabilities: { UPPER: 0.1, CENTER: 0.1, LOWER: 0.1 },
    },
    {
      ...officialResponseFixture.answers.shot_target,
      choice: "UPPER",
    },
  ])("rejects a present but malformed shot-placement answer", (shot_target) => {
    expect(() =>
      normalizeJevResponse(
        {
          ...officialResponseFixture,
          answers: { ...officialResponseFixture.answers, shot_target },
        },
        baseState,
        "invalid-shot",
      ),
    ).toThrow(ProviderError);
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
      "shot_target",
      "use_boost",
    ]);
    expect(body.questions.use_boost.type).toBe("noul");
    expect(body.questions.movement.instructions).toContain("movementLeaseMs");
    expect(body.questions.movement.instructions).toContain("smoothedLatencyMs");
    expect(body.questions.use_boost.instructions).toContain("boostDurationMs");
    expect(body.questions.use_boost.instructions).toContain("boostCooldownMs");
    expect(body.questions.shot_target.type).toBe("choice");
    expect(Object.keys(body.questions.shot_target.criteria)).toEqual([
      "UPPER",
      "CENTER",
      "LOWER",
    ]);
    expect(body.questions.shot_target.instructions).toContain(
      "HUMAN left paddle",
    );
    expect(body.questions.shot_target.instructions).toContain(
      "shotPlacementEnabled",
    );
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

  it("conserves boost when supplied movement capability can already intercept", async () => {
    const state = structuredClone(decisionFixtures.boostAvailable);
    state.prediction.timeToImpactMs = 400;
    state.capabilities.movementSpeed = 680;
    state.capabilities.boostSpeed = 900;
    const fast = await provider.decide(state, { requestId: "fast-capability" });
    state.capabilities.movementSpeed = 150;
    const slow = await provider.decide(state, { requestId: "slow-capability" });
    expect(fast.decision.useBoostProbability).toBeLessThan(0.72);
    expect(slow.decision.useBoostProbability).toBeGreaterThanOrEqual(0.72);
  });

  it("aims away from the projected human position and respects disabled placement", async () => {
    const state = structuredClone(baseState);
    state.humanPaddle.centerY = 300;
    state.humanPaddle.velocityY = -200;
    const movingUp = await provider.decide(state, { requestId: "moving-up" });
    state.humanPaddle.velocityY = 200;
    const movingDown = await provider.decide(state, {
      requestId: "moving-down",
    });
    state.capabilities.shotPlacementEnabled = false;
    const disabled = await provider.decide(state, {
      requestId: "disabled-placement",
    });
    expect(movingUp.decision.shotTarget).toBe("LOWER");
    expect(movingDown.decision.shotTarget).toBe("UPPER");
    expect(disabled.decision.shotTarget).toBe("CENTER");
  });

  it("does not count normal movement beyond the supplied action lease when considering boost", async () => {
    const state = structuredClone(baseState);
    state.prediction.interceptY = 160;
    state.prediction.timeToImpactMs = 1_000;
    state.capabilities.movementSpeed = 150;
    state.capabilities.boostSpeed = 240;
    state.capabilities.movementLeaseMs = 1_000;
    const longLease = await provider.decide(state, { requestId: "long-lease" });
    state.capabilities.movementLeaseMs = 450;
    const shortLease = await provider.decide(state, {
      requestId: "short-lease",
    });
    expect(longLease.decision.useBoostProbability).toBeLessThan(0.72);
    expect(shortLease.decision.useBoostProbability).toBeGreaterThanOrEqual(
      0.72,
    );
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
      expect(
        Object.values(decision.shotTargetProbabilities!).reduce(
          (a, b) => a + b,
        ),
      ).toBeCloseTo(1);
      expect(decision.usage.billable).toBe(false);
    }
  });
});
