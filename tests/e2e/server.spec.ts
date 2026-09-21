import { expect, test } from "@playwright/test";
import type {
  AgentDecisionResponse,
  AgentPublicConfig,
} from "../../lib/agent/contracts";

test("the installed Next route serves real mock decisions to the browser", async ({
  page,
}) => {
  // No route interception and no virtual clock: this verifies the deployed
  // framework boundary, browser Origin headers, and actual mock provider delay.
  const configuration = await page.request.get("/api/agent/config");
  expect(configuration.ok()).toBe(true);
  const config = (await configuration.json()) as AgentPublicConfig;
  test.skip(
    config.provider !== "mock",
    "Browser smoke never spends live-provider tokens",
  );
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agent/decide") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /let.s play/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as AgentDecisionResponse;
  expect(body.decision.source).toBe("mock");
  expect(body.decision.usage.billable).toBe(false);
  expect(body.decision.usage.inputTokens).toBeGreaterThan(0);
  expect(body.decision.timing.serverMs).toBeGreaterThan(0);
  const monitor = page.getByRole("complementary", {
    name: "Agent Decision Monitor",
  });
  await expect(monitor).toContainText("Mock mode");
  await expect(monitor).not.toContainText("Ready when you are");
  await expect(monitor).not.toContainText("fallback active");
  expect(browserErrors).toEqual([]);
});
