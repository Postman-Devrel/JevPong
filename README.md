# Jev Pong

## Public leaderboard

Easy, Medium, and Hard each have a fastest-match leaderboard backed by a private Google Sheet. A completed match ranks when live Fabric/Jev decisions are at least 70% of all recorded decisions. Losses, every strategy, strategy changes, and fallback play are allowed; only each player's fastest qualifying result per level is listed. See [setup, ranking rules, and launch limitations](docs/leaderboard.md). This initial anonymous community board has basic validation, not server-verified anti-cheat.

One paddle. First to seven. A live window into every agent decision.

Jev Pong is a responsive Pong game and an observability demo for [TypeSafe Jev](https://docs.typesafe.ai/introduction). Move with a pointer, a finger, **↑ / ↓**, or **W / S**. The opponent chooses movement, return style, shot placement, and whether to use a boost. Its probabilities, confidence, measured latency, and usage appear beside the match.

**The application runs in clearly labelled mock mode by default. Official live-provider verification is pending until a real TypeSafe API key is configured and the opt-in live check is run.** Mock tokens are simulated and never counted as paid Jev usage.

## Run locally

Use **Node.js 24** and npm. The lockfile records the installed dependency versions.

```sh
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000), press **Play**, and move. No account or API key is needed for mock mode.

### Enable official Jev

Copy the environment template to the ignored local environment file:

```sh
cp .env.example .env.local
```

Set these values in `.env.local`, then restart the development server:

```dotenv
TYPESAFE_API_KEY=your_private_typesafe_key
JEV_PROVIDER=jev
JEV_MODEL=jev-latest
```

Keep the key server-only. Do not use a `NEXT_PUBLIC_` prefix. The browser calls
the application's `/api/agent/decide` route; in direct mode, only that server
route calls the official `https://api.typesafe.ai/v1/systemone` endpoint.

To route requests through a Gateway instead, set the Gateway origin and its
`X-Gateway-key` credential as a pair:

```dotenv
JEV_API_BASE_URL=https://your-gateway.example
FABRIC_GATEWAY_API_KEY=your_private_gateway_key
JEV_PROVIDER=jev
JEV_MODEL=jev-latest
```

The SDK appends `/v1/systemone`, so `JEV_API_BASE_URL` must not contain that
endpoint suffix. In Gateway mode, the application sends only
`FABRIC_GATEWAY_API_KEY` in the `X-Gateway-key` header; it does not send
`TYPESAFE_API_KEY` or an `Authorization` header because Fabric handles upstream
authentication. Set `JEV_PROVIDER=mock` and restart to return to mock mode.

An explicitly selected Jev provider with missing or invalid credentials displays **fallback**. It never silently becomes a mock labelled as Jev. Authentication and configuration errors suspend continuous retries; correct the server configuration and reload the page.

### Configuration

| Variable                           | Default      | Purpose                                                                |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                 | Empty        | Server-only credential used only for direct TypeSafe requests          |
| `FABRIC_GATEWAY_API_KEY`           | Empty        | Server-only `X-Gateway-key` credential                                 |
| `JEV_API_BASE_URL`                 | Official API | Gateway origin; requires `FABRIC_GATEWAY_API_KEY`                      |
| `JEV_PROVIDER`                     | `mock`       | `mock` or `jev`; live mode requires an explicit selection              |
| `JEV_MODEL`                        | `jev-latest` | Requested model; can be pinned to a supported version after evaluation |
| `JEV_DECISION_INTERVAL_MS`         | `250`        | Target sampling interval, not a promised measured decision rate        |
| `JEV_REQUEST_TIMEOUT_MS`           | `900`        | Maximum upstream request duration                                      |
| `JEV_INPUT_PRICE_PER_MILLION_USD`  | `0.042`      | Configurable estimate per million input tokens                         |
| `JEV_OUTPUT_PRICE_PER_MILLION_USD` | `0`          | Configurable estimate per million output tokens                        |
| `JEV_MOCK_LATENCY_MS`              | `72`         | Simulated provider delay in mock mode                                  |
| `JEV_MOCK_SEED`                    | `42`         | Deterministic mock behavior seed                                       |
| `NEXT_PUBLIC_SITE_URL`             | Localhost    | Public site origin used in canonical and social-preview URLs           |

Pricing is configured in `lib/agent/cost.ts` and server environment settings. The initial input and output prices follow the [official model pricing](https://docs.typesafe.ai/models), checked September 21, 2026. Cost remains an estimate, including when actual token counts are returned. Missing usage from failed or cancelled upstream requests cannot be reconstructed; exported totals cover responses observed by the browser.

## Play and inspect

- Move the left paddle with pointer, touch, arrow keys, or W/S. Touch control works on the player's half of the arena.
- **Space** pauses or resumes a focused match. **R** restarts; an active match requires confirmation.
- First to seven wins. Boosts require no extra human input: a charged human boost activates on a strong edge hit.
- **Easy** is the default. Select **Medium** or **Hard** for a tougher opponent. Difficulty controls physical capabilities and action timing; Balanced, Aggressive, and Defensive remain separate strategy choices.
- The decision monitor labels every action **JEV**, **MOCK**, or **FALLBACK**. Reduced confidence limits boost and slows movement at easier levels; very low confidence activates a deterministic fallback.
- Expand the inspector to see a compact game snapshot, the normalized decision, and a redacted provider response. Explanations are templates derived from observable values, never private model reasoning.
- Export session JSON to save aggregate metrics, score, configuration, and recent decisions. Session totals survive match restarts; a page reload starts a fresh session.

Mock mode includes simulated timeout, rate-limit, provider-error, low-confidence, and invalid-response scenarios for checking recovery without a paid API call. The game loop continues through failures.

## Architecture

This is a single Next.js App Router application with TypeScript. Game physics and agent behavior are independent of React and the server framework.

- **Physics loop:** a fixed-step simulation advances logical coordinates and draws to Canvas using `requestAnimationFrame`. It handles collisions, scoring, increasing ball speed, bounded return styles, boost energy, and wall-aware intercept prediction. Resizing changes the drawing scale, not the match geometry.
- **Agent loop:** samples compact state on a separate schedule, with at most one current request. The game continues using the last action during inference. Match, round, direction-version, and sequence checks discard superseded responses. Confidence gating and a visible conservative fallback bound the returned action.
- **Server boundary:** validates snapshots with Zod, constructs fixed questions for the official Choice and Noul primitives, calls TypeSafe with a bounded timeout, and normalizes the response. It accepts no arbitrary player-supplied model instructions. Credentials and upstream error bodies never reach the browser.
- **Browser telemetry:** keeps the most recent 50 decisions and 50 incidents in memory. Cumulative accepted, stale, fallback, and token counts continue for the whole page session. Latency p50/p95 use the last 100 measured round trips; decisions per second uses a rolling five-second window. Mock usage is separate from billable usage. History truncation is explicit in exports.

The authoritative state is local to the browser: this is a single-player product demo, with no multiplayer, accounts, leaderboard, third-party analytics, or persistent player tracking. Opening another tab creates a separate match and telemetry session.

### Gameplay tuning

`lib/game/constants.ts` keeps the physical limits, difficulty profiles, and confidence policy together. The human paddle is 120 pixels tall; the agent paddle is 96. The ball opens at 330 pixels/second, adds 18 on ordinary returns, and caps at 680. The three difficulty settings provide different movement capabilities:

| Difficulty     | Normal / boost speed        | Shot placement               |
| -------------- | --------------------------- | ---------------------------- |
| Easy (default) | 150 / 240 pixels per second | Legacy contact-based returns |
| Medium         | 300 / 480 pixels per second | Model-selected landing zone  |
| Hard           | 450 / 680 pixels per second | Model-selected landing zone  |

Harder settings also recover toward center faster and retain a selected movement long enough to bridge ordinary Gateway latency. Actions remain bounded by their difficulty profile's movement lease, stop on reaching the predicted intercept or recovery target, and expire when their round or ball direction becomes stale. The engine never chooses the opposite movement on the model's behalf.

The `shot_target` Choice question asks Jev to select `UPPER`, `CENTER`, or `LOWER` at the human paddle, independently of movement and return style. Targets sit at 10%, 50%, and 90% of arena height; the engine maps the chosen zone to a legal launch angle. `ANGLED` returns can bank off a wall toward the chosen zone. Shot placement is confidence-gated, disabled on Easy, and never supplied as a tactical aim by fallback code. Older provider responses that omit the new answer remain usable with legacy returns; malformed supplied shot answers are rejected.

Every snapshot includes the selected difficulty, human paddle height/speed, agent movement and boost speeds, confidence/recovery speed scales, boost duration/cooldown, action lease, and shot/ball limits. Normal and boosted reachable paddle-center bounds include measured latency. The movement and boost prompts explicitly use these capabilities so Jev can reason about what the selected difficulty can execute.

Live-session confidence tuning keeps Jev in control at lower certainty: movement below 5% uses deterministic fallback; 5–54% disables boost and runs at 70%, 85%, or 100% paddle speed on Easy, Medium, or Hard respectively; 55% or higher runs at normal speed. Return style falls back to `SAFE` below 30%. Agent boost requires at least 65% boost probability, at least 55% movement confidence, available energy, and an urgent approach. These remain product-tuning values rather than TypeSafe recommendations; exported sessions should be compared when revising them.

Approaching-ball decisions use the configured 250 ms cadence; travel away uses 900 ms on Easy, 500 ms on Medium, and 300 ms on Hard. Movement leases start at 450, 750, and 1,000 ms respectively; Medium and Hard adapt to measured latency up to 1,300 and 1,600 ms. A serve or changed direction immediately requests fresh state, while provider `Retry-After` remains authoritative. Browser round trips use a monotonic clock sampled when the response arrives, independently of animation frames, including returned stale decisions.

The deterministic playability benchmark runs the actual mock provider and controller with simulated response delays. A predictor-driven human varies center and edge placement; a second profile deliberately includes imperfect placement. These synthetic checks evaluate pacing, bounded request rates, and match completion; they are not user research or evidence of live Jev performance. Run `npm test -- tests/unit/playability.test.ts --disableConsoleIntercept` to print the measured results. Validate Hard against competent players through the configured Gateway before claiming a live win rate.

The official integration uses `@typesafe-ai/sdk` with an explicitly validated API base URL, a bounded timeout, an abort signal, `retry.maxRetries: 0`, and SDK logging disabled. The base URL defaults to the official TypeSafe host and can be replaced by a paired Gateway URL and credential. The SDK exposes Choice probabilities/confidence, Noul probability, returned model, and actual token usage; the adapter validates those fields before passing them to the application. Its transport caps successful responses at 64 KiB and discards upstream error details. The next fresh game snapshot is more useful than retrying an expired action, so rate-limit delays are handled between snapshots and respect `Retry-After` (including its millisecond variant).

Important modules:

| Path                               | Responsibility                                                  |
| ---------------------------------- | --------------------------------------------------------------- |
| `components/game/`                 | Canvas, input, match controls, and local audio                  |
| `components/telemetry/`            | Decision monitor, probabilities, history, and inspector         |
| `lib/game/`                        | Deterministic engine, constants, and intercept prediction       |
| `lib/agent/contracts.ts`           | Validated snapshots and stable application decision types       |
| `lib/agent/decision-controller.ts` | Independent agent request loop and stale-result protection      |
| `lib/agent/providers/`             | Mock provider, official SDK adapter, and server configuration   |
| `lib/agent/redact.ts`              | Defensive redaction for inspection and export                   |
| `lib/telemetry/session.ts`         | Bounded history, aggregate metrics, and safe JSON export        |
| `app/api/agent/decide/route.ts`    | Validated same-origin server endpoint                           |
| `tests/`                           | Physics, policy, provider, route, telemetry, and browser checks |

## Verification

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

The browser suite uses Playwright at desktop and 390 × 844 mobile sizes, including an actual server-route smoke test. It starts or reuses a local server on port 3005; set `PLAYWRIGHT_PORT` to override that port. On macOS it uses installed Google Chrome when available. Install Chromium once if the test runner requests it:

```sh
npx playwright install chromium
```

Use `npm run test:watch` while developing. Tests use fixtures and mocks by default and never require live credentials or incur Jev usage.

The live-provider test is skipped unless explicitly enabled. After configuring `.env.local`, this command loads that file and makes real, billable TypeSafe requests:

```sh
JEV_LIVE_TEST=1 node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/jev.live.test.ts
```

If the key is already supplied by the shell or deployment environment, use `JEV_LIVE_TEST=1 npx vitest run tests/integration/jev.live.test.ts`. The live test does not run in the default suite.

To evaluate all 11 representative states without launching the game, opt into the fixture sweep:

```sh
JEV_LIVE_TEST=1 JEV_LIVE_FIXTURES=1 node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/jev.live.test.ts
```

This makes one billable request per fixture and prints only the fixture name, model, selected actions, confidence, timing, and token usage. Fixtures cover approaches above/below/aligned, a fast approach, travel away, boost available/unavailable, each strategy, and an ambiguous prediction. The checks validate the contract; observed choices still need evaluation during a full live match.

Manual release checklist:

1. Start a match; try pointer, keyboard, and touch on a narrow viewport.
2. Pause, resume, hide the tab, return, and resize during a rally.
3. Finish a first-to-seven match and start another without reloading.
4. Activate each mock failure and confirm the match continues with an accurate fallback label.
5. Inspect a decision and export JSON; check separate mock/real usage and bounded history.
6. With official Jev configured, confirm a versioned returned model, measured latency, real usage, and a visible fallback if the connection fails.

## Deployment

### Verified build

Verified September 21, 2026:

- `npm run format:check`, `npm run lint`, and `npm run typecheck` passed.
- `npm run test`: **82 passed**, with the explicit opt-in live-provider test skipped.
- `npm run test:e2e`: **15 passed**, with the touch-only case skipped in the desktop project. Coverage includes complete matches, keyboard/pointer/touch input, failure recovery, malformed configuration, inspector/export redaction, and the real Next.js mock API on desktop and mobile.
- `npm run build` passed. A non-secret build canary confirmed that credentials are absent from browser bundles. Provider SDK code and credential environment access are server-only.

The local preview for this build uses [localhost:3005](http://localhost:3005), since another application already occupied port 3000. Run `npm start -- --port 3005` after building to use that same preview address. The normal development command still defaults to port 3000.

Official live verification remains pending. Configure the key locally and run the opt-in live check described above before presenting this as a verified live Jev demo.

### Hosting

Deploy to a Node-capable Next.js host such as Vercel, or run:

```sh
npm run build
npm start
```

Set the server environment variables in the host's secret configuration and explicitly select `JEV_PROVIDER=jev` for live play. The agent route requires a server runtime; static export is not supported. Keep the upstream timeout below the host's request duration limit.

The API route enforces a 12 KiB JSON limit, same-origin checks, and a basic in-memory abuse guard. Token buckets allow eight requests per second per hashed IP address (burst 12) and 15 per second in aggregate (burst 30). That guard is scoped to one server instance and resets on restart; it is **not shared across replicas**. For a widely shared paid live demo, add platform-level rate limiting or a shared limiter and enforce a provider spending limit. There is no per-user authentication or billing system in this version.

## Assumptions and limits

- The game prioritizes easy movement and a readable live demo over competitive Pong accuracy. Initial confidence thresholds and pacing are tunable hypotheses.
- Normal live movement comes from Jev. Wall prediction, confidence gating, safe fallback, and collision behavior are deterministic application code and are labelled accordingly.
- Official responses do not expose a provider-only duration, so `providerMs` stays `null`. The UI reports measured browser-to-server round-trip time instead.
- Exported telemetry includes only retained recent events and full-session aggregates. It excludes request headers, credentials, environment values, stack traces, and browser identifiers. Large inspection payloads are truncated defensively.
- Background play pauses. Device refresh rate, network latency, provider availability, and server capacity determine observed performance.
- Implementation and mock verification do not establish live Jev quality. A real credential, the opt-in live check, and a full live match are still required before calling the live-provider integration verified.

Official references: [API contract](https://docs.typesafe.ai/api), [quick start](https://docs.typesafe.ai/introduction/quickstart), [confidence guidance](https://docs.typesafe.ai/confidence), [Choice primitive](https://docs.typesafe.ai/primitives/choice), and [TypeSafe coding-agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md).
