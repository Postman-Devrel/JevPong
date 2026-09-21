import type { AgentPublicConfig } from "../contracts";
import { DEFAULT_PRICING } from "../cost";

export interface ServerAgentConfig extends AgentPublicConfig {
  apiKey: string;
  apiBaseURL: string;
  gatewayApiKey: string;
  mockLatencyMs: number;
  mockSeed: number;
  configurationError?: boolean;
}

export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai";

function normalizeApiBaseURL(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return TYPESAFE_API_BASE_URL;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return null;
    const path = url.pathname.replace(/\/+$/, "");
    // The SDK appends /v1/systemone; accepting the full endpoint would double it.
    if (path.endsWith("/v1/systemone")) return null;
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

/** Imported by server routes only. Credentials never belong in public config. */
export function getServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerAgentConfig {
  const selectedProvider = env.JEV_PROVIDER?.trim() || "mock";
  const provider = selectedProvider === "mock" ? "mock" : "jev";
  const selectedModel = env.JEV_MODEL?.trim() || "jev-latest";
  const validModel = /^jev-[a-zA-Z0-9.-]{1,70}$/.test(selectedModel);
  const model = validModel ? selectedModel : "jev-latest";
  const selectedBaseURL = env.JEV_API_BASE_URL?.trim() ?? "";
  const customBaseURL = selectedBaseURL.length > 0;
  const apiBaseURL = normalizeApiBaseURL(selectedBaseURL);
  const gatewayApiKey = env.FABRIC_GATEWAY_API_KEY?.trim() ?? "";
  const typeSafeApiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  const gatewayConfigurationMismatch =
    customBaseURL !== gatewayApiKey.length > 0;
  const configurationError =
    (selectedProvider !== "mock" && selectedProvider !== "jev") ||
    !validModel ||
    apiBaseURL === null ||
    gatewayConfigurationMismatch;
  const apiKey = typeSafeApiKey;
  return {
    provider,
    model,
    apiKey,
    apiBaseURL: apiBaseURL ?? TYPESAFE_API_BASE_URL,
    gatewayApiKey,
    configurationError,
    configured:
      !configurationError &&
      (provider === "mock" ||
        (customBaseURL ? gatewayApiKey.length > 0 : apiKey.length > 0)),
    decisionIntervalMs: Math.round(
      boundedNumber(env.JEV_DECISION_INTERVAL_MS, 250, 150, 2_000),
    ),
    requestTimeoutMs: Math.round(
      boundedNumber(env.JEV_REQUEST_TIMEOUT_MS, 900, 100, 5_000),
    ),
    pricing: {
      inputPerMillionUsd: boundedNumber(
        env.JEV_INPUT_PRICE_PER_MILLION_USD,
        DEFAULT_PRICING.inputPerMillionUsd,
        0,
        1_000,
      ),
      outputPerMillionUsd: boundedNumber(
        env.JEV_OUTPUT_PRICE_PER_MILLION_USD,
        DEFAULT_PRICING.outputPerMillionUsd,
        0,
        1_000,
      ),
    },
    mockScenariosEnabled: provider === "mock",
    mockLatencyMs: Math.round(
      boundedNumber(env.JEV_MOCK_LATENCY_MS, 72, 0, 3_000),
    ),
    mockSeed: Math.round(
      boundedNumber(env.JEV_MOCK_SEED, 42, 0, 2_147_483_647),
    ),
  };
}

export function publicConfig(config: ServerAgentConfig): AgentPublicConfig {
  const {
    provider,
    model,
    configured,
    decisionIntervalMs,
    requestTimeoutMs,
    pricing,
    mockScenariosEnabled,
  } = config;
  return {
    provider,
    model,
    configured,
    decisionIntervalMs,
    requestTimeoutMs,
    pricing,
    mockScenariosEnabled,
  };
}
