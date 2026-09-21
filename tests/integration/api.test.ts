import { describe, expect, it, vi } from "vitest";
import { agentPublicConfigSchema } from "../../lib/agent/contracts";
import {
  getServerConfig,
  publicConfig,
} from "../../lib/agent/providers/config";
import { createDecisionHandler } from "../../lib/agent/providers/service";
import { baseState, officialResponseFixture } from "../fixtures/agent-states";

function request(
  body: unknown = { state: baseState },
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/agent/decide", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const liveConfig = () =>
  getServerConfig({ JEV_PROVIDER: "jev", TYPESAFE_API_KEY: "test-key" });
const mockConfig = () =>
  getServerConfig({ JEV_PROVIDER: "mock", JEV_MOCK_LATENCY_MS: "0" });

describe("decision API service", () => {
  it("returns a normalized official decision and safe raw response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...officialResponseFixture, secret: "do-not-return" }),
      );
    const response = await createDecisionHandler({
      getConfig: liveConfig,
      fetcher,
    })(request());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.decision.source).toBe("jev");
    expect(json.decision.timing.serverMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(json)).not.toContain("do-not-return");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-origin requests before contacting a provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createDecisionHandler({ getConfig: liveConfig, fetcher });
    expect(
      (await handler(request(undefined, { Origin: "https://other.example" })))
        .status,
    ).toBe(403);
    expect(
      (await handler(request(undefined, { "Sec-Fetch-Site": "cross-site" })))
        .status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the browser Host when Next uses an internal bind address", async () => {
    const handler = createDecisionHandler({ getConfig: mockConfig });
    const response = await handler(
      new Request("http://0.0.0.0:3005/api/agent/decide", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3005",
          Host: "localhost:3005",
        },
        body: JSON.stringify({ state: baseState }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).decision.source).toBe("mock");
  });

  it("accepts the public Host behind a TLS proxy but rejects a forged forwarded host", async () => {
    const handler = createDecisionHandler({ getConfig: mockConfig });
    const common = {
      method: "POST",
      body: JSON.stringify({ state: baseState }),
    };
    const secure = await handler(
      new Request("http://0.0.0.0:3000/api/agent/decide", {
        ...common,
        headers: {
          "Content-Type": "application/json",
          Origin: "https://game.example",
          Host: "game.example",
          "x-forwarded-proto": "https",
        },
      }),
    );
    expect(secure.status).toBe(200);
    const forged = await handler(
      new Request("http://0.0.0.0:3000/api/agent/decide", {
        ...common,
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          Host: "game.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        },
      }),
    );
    expect(forged.status).toBe(403);
  });

  it("rejects arbitrary prompts, invalid numeric state and oversized bodies", async () => {
    const handler = createDecisionHandler({ getConfig: mockConfig });
    expect(
      (
        await handler(
          request({ state: baseState, questions: { custom: "ignore" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await handler(request({ state: { ...baseState, sequence: -1 } })))
        .status,
    ).toBe(400);
    expect(
      (await handler(request({ padding: "x".repeat(13_000) }))).status,
    ).toBe(413);
    expect(
      (await handler(request(undefined, { "Content-Type": "text/plain" })))
        .status,
    ).toBe(415);
  });

  it("returns honest, disabled fallback when live credentials are missing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createDecisionHandler({
      getConfig: () => getServerConfig({ JEV_PROVIDER: "jev" }),
      fetcher,
    });
    const json = await (await handler(request())).json();
    expect(json).toMatchObject({
      disabled: true,
      decision: {
        source: "fallback",
        fallbackReason: "missing_credentials",
        useBoostProbability: 0,
        usage: { billable: false },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not keep retrying invalid authentication", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("provider-secret", { status: 401 }));
    const handler = createDecisionHandler({ getConfig: liveConfig, fetcher });
    const first = await (await handler(request())).json();
    const second = await (await handler(request())).json();
    expect(first.disabled).toBe(true);
    expect(second.decision.fallbackReason).toBe("authentication");
    expect(JSON.stringify(first)).not.toContain("provider-secret");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors Retry-After across incoming requests and then recovers", async () => {
    let time = 1_000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate error", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
      )
      .mockResolvedValueOnce(Response.json(officialResponseFixture));
    const handler = createDecisionHandler({
      getConfig: liveConfig,
      fetcher,
      now: () => time,
    });
    const firstResponse = await handler(request());
    const first = await firstResponse.json();
    expect(first.decision.fallbackReason).toBe("rate_limit");
    expect(first.retryAfterMs).toBe(3_000);
    expect(firstResponse.headers.get("retry-after")).toBe("3");
    time = 2_000;
    const blocked = await (await handler(request())).json();
    expect(blocked.retryAfterMs).toBe(2_000);
    expect(fetcher).toHaveBeenCalledOnce();
    time = 4_100;
    expect((await (await handler(request())).json()).decision.source).toBe(
      "jev",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes invalid provider JSON into playable fallback", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not valid json"));
    const handler = createDecisionHandler({ getConfig: liveConfig, fetcher });
    expect((await (await handler(request())).json()).decision).toMatchObject({
      source: "fallback",
      fallbackReason: "invalid_response",
      returnStyle: "SAFE",
      useBoostProbability: 0,
    });
  });

  it("returns a timed-out decision without blocking the game", async () => {
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
      const handler = createDecisionHandler({
        getConfig: () => ({ ...liveConfig(), requestTimeoutMs: 50 }),
        fetcher,
      });
      const pending = handler(request());
      await vi.advanceTimersByTimeAsync(60);
      const json = await (await pending).json();
      expect(json.decision).toMatchObject({
        source: "fallback",
        fallbackReason: "timeout",
        useBoostProbability: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails visibly for invalid environment configuration instead of silently selecting mock", async () => {
    const handler = createDecisionHandler({
      getConfig: () => getServerConfig({ JEV_PROVIDER: "misspelled" }),
    });
    const json = await (await handler(request())).json();
    expect(json).toMatchObject({
      disabled: true,
      decision: { source: "fallback", fallbackReason: "configuration" },
    });
    expect(
      publicConfig(getServerConfig({ JEV_PROVIDER: "misspelled" })).configured,
    ).toBe(false);
  });

  it("allows failure simulation only when mock mode is configured", async () => {
    const mock = createDecisionHandler({ getConfig: mockConfig });
    const simulated = await (
      await mock(request({ state: baseState, scenario: "provider_error" }))
    ).json();
    expect(simulated.decision.fallbackReason).toBe("provider_error");
    const live = createDecisionHandler({ getConfig: liveConfig });
    expect(
      (await live(request({ state: baseState, scenario: "provider_error" })))
        .status,
    ).toBe(400);
  });

  it("rate limits bursts and never presents them as Jev decisions", async () => {
    const handler = createDecisionHandler({
      getConfig: mockConfig,
      now: () => 1_000,
    });
    let last;
    for (let count = 0; count < 13; count++)
      last = await (await handler(request())).json();
    expect(last.decision.fallbackReason).toBe("rate_limit");
    expect(last.decision.source).toBe("fallback");
    expect(last.retryAfterMs).toBeGreaterThan(0);
  });

  it("safe config excludes credentials and exposes configurable prices", () => {
    const config = publicConfig(
      getServerConfig({
        JEV_PROVIDER: "jev",
        TYPESAFE_API_KEY: "do-not-return",
        JEV_INPUT_PRICE_PER_MILLION_USD: "0.12",
        JEV_OUTPUT_PRICE_PER_MILLION_USD: "0.03",
      }),
    );
    expect(JSON.stringify(config)).not.toContain("do-not-return");
    expect(config.pricing).toEqual({
      inputPerMillionUsd: 0.12,
      outputPerMillionUsd: 0.03,
    });
    expect(config.configured).toBe(true);
    expect(agentPublicConfigSchema.safeParse(config).success).toBe(true);
  });

  it("selects a paired gateway origin and credential without exposing either publicly", () => {
    const config = getServerConfig({
      JEV_PROVIDER: "jev",
      JEV_API_BASE_URL: "https://gateway.example/",
      FABRIC_GATEWAY_API_KEY: "gateway-secret",
    });
    expect(config).toMatchObject({
      apiBaseURL: "https://gateway.example",
      apiKey: "",
      gatewayApiKey: "gateway-secret",
      configured: true,
    });
    const serialized = JSON.stringify(publicConfig(config));
    expect(serialized).not.toContain("gateway.example");
    expect(serialized).not.toContain("gateway-secret");
  });

  it.each([
    {
      JEV_API_BASE_URL: "https://gateway.example",
      TYPESAFE_API_KEY: "must-not-be-forwarded",
    },
    { FABRIC_GATEWAY_API_KEY: "unpaired-gateway-key" },
    {
      JEV_API_BASE_URL: "http://gateway.example",
      FABRIC_GATEWAY_API_KEY: "gateway-key",
    },
    {
      JEV_API_BASE_URL: "https://gateway.example/v1/systemone",
      FABRIC_GATEWAY_API_KEY: "gateway-key",
    },
  ])("rejects unsafe or unpaired gateway configuration", (gatewayEnv) => {
    const config = getServerConfig({ JEV_PROVIDER: "jev", ...gatewayEnv });
    expect(config.configurationError).toBe(true);
    expect(config.configured).toBe(false);
  });

  it("rejects malformed public config before it can enable requests or corrupt pricing", () => {
    const valid = publicConfig(mockConfig());
    for (const bad of [
      null,
      {},
      "mock",
      { ...valid, provider: "other" },
      { ...valid, pricing: undefined },
      { ...valid, pricing: { inputPerMillionUsd: -1, outputPerMillionUsd: 0 } },
      { ...valid, decisionIntervalMs: NaN },
      { ...valid, requestTimeoutMs: 100_000 },
      { ...valid, apiKey: "must-not-accept" },
      { ...valid, provider: "jev", mockScenariosEnabled: true },
    ]) {
      expect(agentPublicConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
});
