import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type {
  AgentDecision,
  AgentGameState,
  AgentPublicConfig,
} from "../../lib/agent/contracts";

const CONFIG: AgentPublicConfig = {
  provider: "mock",
  model: "jev-latest",
  configured: true,
  decisionIntervalMs: 250,
  requestTimeoutMs: 900,
  pricing: { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0 },
  mockScenariosEnabled: true,
};

const SECRET_MARKER = "browser-fixture-credential-must-never-export";

function fixtureDecision(
  state: AgentGameState,
  fallback: boolean,
): AgentDecision {
  return {
    sequence: state.sequence,
    matchId: state.matchId,
    roundId: state.roundId,
    directionVersion: state.directionVersion,
    requestId: `browser-${state.sequence}`,
    movement: "HOLD",
    movementProbabilities: { UP: 0.05, DOWN: 0.05, HOLD: 0.9 },
    movementConfidence: 0.9,
    returnStyle: "SAFE",
    returnStyleProbabilities: { SAFE: 0.9, ANGLED: 0.05, FAST: 0.05 },
    returnStyleConfidence: 0.9,
    useBoostProbability: 0.1,
    model: "mock-browser-fixture",
    usage: { inputTokens: 120, outputTokens: 12, billable: false },
    timing: { serverMs: 10, providerMs: null, roundTripMs: null },
    source: fallback ? "fallback" : "mock",
    ...(fallback ? { fallbackReason: "timeout" as const } : {}),
  };
}

/** Exercise browser inputs and the real game/controller through the public API boundary. */
async function setup(page: Page, options: { malformedConfig?: boolean } = {}) {
  const states: AgentGameState[] = [];
  let fallback = false;
  let validConfiguration = !options.malformedConfig;
  let configRequests = 0;
  await page.route("**/api/agent/config", (route) => {
    configRequests += 1;
    return route.fulfill({ json: validConfiguration ? CONFIG : {} });
  });
  await page.route("**/api/agent/decide", async (route) => {
    const { state } = route.request().postDataJSON() as {
      state: AgentGameState;
    };
    states.push(state);
    await route.fulfill({
      json: {
        decision: fixtureDecision(state, fallback),
        rawResponse: {
          model: "mock-browser-fixture",
          apiKey: SECRET_MARKER,
          nested: { authorization: `Bearer ${SECRET_MARKER}` },
          answers: { movement: "HOLD" },
        },
      },
    });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("button", { name: /let.s play/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute sound" })).toBeVisible();
  // Freeze only after hydration. Virtual time accelerates real rendering and
  // simulation; it does not expose or alter any production game state.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  return {
    states,
    enableConfiguration: () => {
      validConfiguration = true;
    },
    configRequests: () => configRequests,
    setFallback: () => {
      fallback = true;
    },
  };
}

async function advance(page: Page, milliseconds: number) {
  // Short slices allow route responses and React updates between animation ticks.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
    await page.clock.runFor(Math.min(250, milliseconds - elapsed));
    await page.evaluate(() => Promise.resolve());
  }
}

async function start(page: Page, states: AgentGameState[]) {
  await page.getByRole("button", { name: /let.s play/i }).click();
  await advance(page, 3_750);
  await expect.poll(() => states.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Pause match", exact: true }),
  ).toBeVisible();
}

function canvas(page: Page) {
  return page.locator("canvas[aria-label^='Pong arena']");
}

test("starts immediately, shows real telemetry updates, and responds to pointer and keyboard", async ({
  page,
}) => {
  const { states } = await setup(page);
  await start(page, states);
  await expect(
    page.getByRole("complementary", { name: "Agent Decision Monitor" }),
  ).toContainText("Hold position");
  await expect(
    page.getByRole("complementary", { name: "Agent Decision Monitor" }),
  ).toContainText("Mock mode");
  const court = await canvas(page).boundingBox();
  expect(court).not.toBeNull();
  if (!court) return;

  await page.mouse.move(
    court.x + court.width * 0.2,
    court.y + court.height * 0.15,
  );
  // Calls are deliberately less frequent while the ball travels away. Allow
  // the next rally to expose the settled paddle position through a snapshot.
  await advance(page, 4_000);
  expect(states.at(-1)!.humanPaddle.centerY).toBeLessThan(160);

  await canvas(page).focus();
  await page.keyboard.down("ArrowDown");
  await advance(page, 450);
  await page.keyboard.up("ArrowDown");
  // The deliberately high pointer position may have conceded the first serve.
  // Wait through a possible inter-point countdown for a fresh public snapshot.
  await advance(page, 4_000);
  expect(states.at(-1)!.humanPaddle.centerY).toBeGreaterThan(300);

  await page.getByText("Session performance", { exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Agent Decision Monitor" }),
  ).toContainText("mock-browser-fixture");
  await expect(
    page.getByRole("complementary", { name: "Agent Decision Monitor" }),
  ).toContainText("$0.000000");
});

test("defaults to hard, allows easy and medium, and confirms changes during a match", async ({
  page,
}) => {
  const { states } = await setup(page);
  const easy = page.getByRole("button", {
    name: "Easy",
    exact: true,
  });
  const medium = page.getByRole("button", {
    name: "Medium",
    exact: true,
  });
  const hard = page.getByRole("button", {
    name: "Hard",
    exact: true,
  });
  await expect(hard).toHaveAttribute("aria-pressed", "true");
  await medium.click();
  await expect(medium).toHaveAttribute("aria-pressed", "true");
  await easy.click();
  await expect(easy).toHaveAttribute("aria-pressed", "true");
  await expect(hard).toHaveAttribute("aria-pressed", "false");
  await start(page, states);
  expect(states.at(-1)!.difficulty).toBe(1);
  expect(states.at(-1)!.capabilities.shotPlacementEnabled).toBe(false);
  const originalMatch = states.at(-1)!.matchId;

  await medium.click();
  const dialog = page.getByRole("dialog", { name: "Change difficulty?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep this match" }).click();
  await expect(easy).toHaveAttribute("aria-pressed", "true");
  await advance(page, 3_500);
  expect(states.at(-1)!.matchId).toBe(originalMatch);
  expect(states.at(-1)!.difficulty).toBe(1);

  await medium.click();
  await dialog.getByRole("button", { name: "Restart on Medium" }).click();
  await advance(page, 3_750);
  await expect(medium).toHaveAttribute("aria-pressed", "true");
  expect(states.at(-1)!.difficulty).toBe(2);
  expect(states.at(-1)!.matchId).not.toBe(originalMatch);
  expect(states.at(-1)!.capabilities.shotPlacementEnabled).toBe(true);
  const mediumMatch = states.at(-1)!.matchId;

  await page
    .getByRole("button", { name: "Restart match", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "A fresh start?" })
    .getByRole("button", { name: "Restart match", exact: true })
    .click();
  await advance(page, 3_750);
  expect(states.at(-1)!.difficulty).toBe(2);
  expect(states.at(-1)!.matchId).not.toBe(mediumMatch);
  await expect(medium).toHaveAttribute("aria-pressed", "true");

  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export session", exact: true })
    .click();
  const download = await downloaded;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.matchConfiguration).toMatchObject({
    difficulty: 2,
    difficultyProfile: { level: 2, label: "Medium", aiSpeed: 300 },
  });
  expect(
    exported.events.some(
      (event: { snapshot: AgentGameState }) => event.snapshot.difficulty === 1,
    ),
  ).toBe(true);
  expect(
    exported.events.some(
      (event: { snapshot: AgentGameState }) => event.snapshot.difficulty === 2,
    ),
  ).toBe(true);
});

test("malformed configuration stays playable without agent requests and recovers after retry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await setup(page, { malformedConfig: true });
  await page.getByRole("button", { name: /let.s play/i }).click();
  await advance(page, 3_750);
  const monitor = page.getByRole("complementary", {
    name: "Agent Decision Monitor",
  });
  await expect(monitor).toContainText("fallback active");
  await expect(
    page.getByRole("button", { name: "Pause match", exact: true }),
  ).toBeVisible();
  expect(fixture.states).toHaveLength(0);
  expect(fixture.configRequests()).toBeGreaterThanOrEqual(2);

  fixture.enableConfiguration();
  await advance(page, 2_500);
  expect(fixture.states.length).toBeGreaterThan(0);
  await expect(monitor).toContainText("Mock mode");
  await expect(monitor).not.toContainText("fallback active");
  expect(errors).toEqual([]);
});

test("pauses, resumes with a countdown, and preserves logical coordinates after resize", async ({
  page,
}) => {
  const { states } = await setup(page);
  await start(page, states);
  await canvas(page).focus();
  await page.keyboard.press("Space");
  await advance(page, 250);
  await expect(
    page.getByRole("heading", { name: "Take a breather." }),
  ).toBeVisible();
  const pausedRequests = states.length;
  const pausedScore = await page
    .locator(".scoreboard")
    .getAttribute("aria-label");
  await advance(page, 2_000);
  expect(states.length).toBe(pausedRequests);
  await expect(page.locator(".scoreboard")).toHaveAttribute(
    "aria-label",
    pausedScore!,
  );

  await page.setViewportSize({ width: 700, height: 800 });
  await page.getByRole("button", { name: "Keep playing", exact: true }).click();
  await advance(page, 500);
  await expect(
    page.getByText("Move your paddle to get a feel for it.", { exact: true }),
  ).toBeVisible();
  await advance(page, 3_250);
  expect(states.length).toBeGreaterThan(pausedRequests);
  expect(states.at(-1)!.arena).toEqual({ width: 960, height: 600 });
  expect(Number.isFinite(states.at(-1)!.ball.x)).toBe(true);
  expect(Number.isFinite(states.at(-1)!.ball.y)).toBe(true);
});

test("fallback is visible while physics and telemetry continue", async ({
  page,
}) => {
  const fixture = await setup(page);
  await start(page, fixture.states);
  const previous = fixture.states.at(-1)!;
  fixture.setFallback();
  await advance(page, 1_250);
  await expect(
    page.getByRole("complementary", { name: "Agent Decision Monitor" }),
  ).toContainText("fallback active");
  expect(fixture.states.at(-1)!.capturedAtMs).toBeGreaterThan(
    previous.capturedAtMs,
  );
  expect(fixture.states.at(-1)!.sequence).toBeGreaterThan(previous.sequence);
  await expect(
    page.getByRole("button", { name: "Pause match", exact: true }),
  ).toBeVisible();
});

test("inspector and downloaded session redact secrets and retain useful decisions", async ({
  page,
}) => {
  const { states } = await setup(page);
  await start(page, states);
  await page
    .getByRole("button", { name: "Inspect the decision", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Provider response" }).click();
  await expect(page.locator(".json-view")).toContainText("[REDACTED]");
  await expect(page.locator(".json-view")).not.toContainText(SECRET_MARKER);
  await page.getByRole("button", { name: "Close dialog" }).click();

  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export session", exact: true })
    .click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, "utf8");
  const exported = JSON.parse(text);
  expect(text).not.toContain(SECRET_MARKER);
  expect(exported).toMatchObject({
    appVersion: "1.0.0",
    matchConfiguration: {
      width: 960,
      height: 600,
      winningScore: 7,
      difficulty: 3,
    },
    modelConfiguration: { provider: "mock" },
    metrics: { inputTokens: 0, estimatedCostUsd: 0 },
    retention: { historyLimit: 50 },
  });
  expect(exported.metrics.accepted).toBeGreaterThan(0);
  expect(exported.events.length).toBeGreaterThan(0);
  expect(exported.events[0].snapshot.arena).toEqual({
    width: 960,
    height: 600,
  });
  expect(exported.events[0].rawResponse.apiKey).toBe("[REDACTED]");
});

test("finishes a first-to-seven match and restarts without reloading", async ({
  page,
}) => {
  const { states } = await setup(page);
  await page.getByLabel("Player name").fill("Ada Lovelace");
  await start(page, states);
  // Deliberately miss serves using the same pointer control as a visitor.
  // HOLD is a valid agent action, so neither production game state nor scores are modified.
  const court = await canvas(page).boundingBox();
  if (!court) throw new Error("Canvas is not visible");
  await page.mouse.move(court.x + court.width * 0.15, court.y + 1);
  for (let elapsed = 0; elapsed < 80_000; elapsed += 2_000) {
    await advance(page, 2_000);
    if (await page.getByRole("button", { name: "One more round" }).isVisible())
      break;
  }
  await expect(
    page.getByRole("button", { name: "One more round" }),
  ).toBeVisible();
  await expect(page.locator(".scoreboard")).toHaveAttribute(
    "aria-label",
    /(?:Ada Lovelace 7, Jev [0-6]|Ada Lovelace [0-6], Jev 7)/,
  );
  await page.getByRole("button", { name: "Share your result" }).click();
  await expect(
    page.getByRole("heading", { name: "Your match receipt" }),
  ).toBeVisible();
  await expect(page.getByAltText(/Ada Lovelace .* Jev/)).toBeVisible();
  const cardDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG" }).click();
  const cardDownload = await cardDownloadPromise;
  expect(cardDownload.suggestedFilename()).toMatch(
    /^jev-pong-ada-lovelace-(?:7-[0-6]|[0-6]-7)-hard\.png$/,
  );
  const cardPath = await cardDownload.path();
  expect(cardPath).not.toBeNull();
  const cardBytes = await readFile(cardPath!);
  expect(cardBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  if (process.env.RESULT_CARD_QA_PATH)
    await cardDownload.saveAs(process.env.RESULT_CARD_QA_PATH);
  await page.getByRole("button", { name: "Close dialog" }).click();
  const previousMatch = states.at(-1)!.matchId;
  const previousRequests = states.length;
  await page.getByRole("button", { name: "One more round" }).click();
  await advance(page, 3_750);
  expect(states.length).toBeGreaterThan(previousRequests);
  expect(states.at(-1)!.matchId).not.toBe(previousMatch);
  await expect(page.locator(".scoreboard")).toHaveAttribute(
    "aria-label",
    "Score: Ada Lovelace 0, Jev 0",
  );
});

test("touch dragging controls the paddle on a narrow viewport", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch project verifies real browser touch events");
  const { states } = await setup(page);
  await start(page, states);
  const court = await canvas(page).boundingBox();
  if (!court) throw new Error("Canvas is not visible");
  const client = await page.context().newCDPSession(page);
  const x = court.x + court.width * 0.2;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: court.y + court.height * 0.5 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: court.y + court.height * 0.8 }],
  });
  await advance(page, 1_000);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  expect(states.at(-1)!.humanPaddle.centerY).toBeGreaterThan(420);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
