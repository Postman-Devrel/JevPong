import { expect, test } from "@playwright/test";
import type {
  AgentDecisionResponse,
  AgentPublicConfig,
} from "../../lib/agent/contracts";

test("publishes complete social-preview metadata and generated images", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Jev Pong — Human instinct. Machine intelligence.",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
    "content",
    "1200",
  );
  await expect(
    page.locator('meta[property="og:image:height"]'),
  ).toHaveAttribute("content", "630");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(1);

  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
  ]) {
    const imageUrl = await page.locator(selector).getAttribute("content");
    expect(imageUrl).not.toBeNull();
    const parsedImageUrl = new URL(imageUrl!);
    const response = await page.request.get(
      `${parsedImageUrl.pathname}${parsedImageUrl.search}`,
    );
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
    const body = await response.body();
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(body.byteLength).toBeLessThan(5 * 1024 * 1024);
  }
});

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
