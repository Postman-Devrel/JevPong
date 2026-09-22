# Google Sheets leaderboard

The game has three public boards (Easy, Medium, Hard), match logging, and a post-match rank. Google Sheets stays **private**. Browsers call Next.js; only the server calls the authenticated Apps Script adapter. No Google or gateway credentials enter the client bundle.

## Rules for this first release

- First to seven. Rank every completed match by match time, fastest first, rounded to hundredths of a second. Time includes all countdowns and excludes pauses, using the game's fixed-step clock.
- One personal best per anonymous browser identity per difficulty. Identical times share competition rank (1, 1, 3); completion time and match ID stabilize display order.
- A slower repeat does not replace a personal best. The result screen shows that run's position against other players' bests, plus the player's retained personal best.
- A valid completed match ranks when live Fabric/Jev decisions are at least 70% of all recorded decisions (`live / (live + fallback + mock)`). Exactly 70% qualifies. Losses, fallback decisions, every strategy, and strategy changes are allowed. Zero-live, mock-provider, and below-70% runs are logged but unranked. Restarted or abandoned runs remain `started` and never rank because they were not completed.
- Default nickname is `Player 01`. Nicknames are not unique or verified. Browser identity uses a signed HttpOnly cookie for one year; clearing cookies or using a different device creates a separate identity. No email, IP address, API response, or credentials are stored in the sheet.
- Maximum submitted match time is two hours; finish submission expires after two hours and five minutes. Failed saves can be retried while the result screen remains open. Leaving/reloading before confirmation can lose an unsaved result; there is no durable offline queue.
- `LEADERBOARD_VERSION` partitions the board by game rules. Bump it whenever physics, model configuration, or difficulty tuning changes materially; old rows remain available in the sheet but are excluded from the new board.

## Important launch limitations

This is a **community leaderboard, not cheat-proof competition**. Signed tickets bind identity, level, name, provider, and start time. The server checks score shape, time bounds, origin, body size, and rate limits. A shared Google script lock makes match writes idempotent across server instances.

But the browser still reports scores, duration, decision counts, and strategy changes. A determined player can forge those claims after obtaining a valid ticket. Neither a signature nor a sheet proves a genuine match result. For prizes, verified tournaments, or stronger integrity, add authenticated players and server-authoritative simulation or validated replay with server-authenticated Jev actions before launch.

The Next.js limiter is per-instance. Add a trusted-proxy edge/WAF rate limit for `/api/leaderboard/*` and `/api/agent/*` on your host. Configure the proxy to overwrite forwarding headers. Apps Script and Sheets have quotas and are appropriate for an initial modest-traffic launch, not unbounded global traffic. The adapter reads the match table to rank it; archive old seasons and migrate storage when latency or quota pressure rises. See [Google's quota reference](https://developers.google.com/apps-script/guides/services/quotas).

## Connect your sheet

1. Create or choose a private Google Sheet dedicated to Jev Pong. Do **not** publish it or grant public edit access.
   If the current sharing setting is “Anyone with the link,” change **Share → General access → Restricted** before connecting. Only the app's leaderboard needs to be public, not the raw sheet.
2. Open **Extensions → Apps Script**. Copy `integrations/google-sheets/Leaderboard.gs` into the script project.
3. In **Project Settings → Script Properties**, add:
   - `SPREADSHEET_ID`: the ID between `/d/` and `/edit` in the sheet URL.
   - `LEADERBOARD_SECRET`: a randomly generated secret of at least 32 characters. Generate one locally, for example `openssl rand -hex 32`. Never paste it into chat or commit it.
4. Run `setupLeaderboard` manually and authorize access. It creates the `Matches` tab only if absent, writes the required header row only if empty, and refuses an incompatible existing schema. It does not modify other tabs.
5. Deploy as a **Web app**, **Execute as: Me**, with access allowing **Anyone** to invoke it. This makes the endpoint reachable, not the data publicly accessible: every operation checks the shared secret. Your Google/Workspace policy may prohibit this deployment; in that case use a service-account-based adapter instead. Review this permission choice yourself before deploying. See [Google's web app guide](https://developers.google.com/apps-script/guides/web).
6. Put the deployed `/exec` URL and the same secret into `.env.local` and your hosting environment:

   ```dotenv
   GOOGLE_SHEETS_LEADERBOARD_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
   LEADERBOARD_SECRET=YOUR_RANDOM_SECRET
   ```

   Do **not** use a `NEXT_PUBLIC_` prefix or the development `/dev` URL. A
   domain-scoped URL shaped like
   `https://script.google.com/a/macros/YOUR_DOMAIN/.../exec` requires a Google
   sign-in and returns `401` to the Next.js server; it is not suitable for this
   integration. The usable deployment URL starts with
   `https://script.google.com/macros/s/` and ends with `/exec`. Restart the
   local dev server after changing the environment.

7. Set `JEV_PROVIDER=jev` and keep the existing gateway settings. Fallback and alternate-strategy games rank when the live-decision share remains at least 70%; mock-provider games do not rank.
8. Reload the game. The board should show an empty-state invitation rather than “coming soon.” Play a test match: its row starts as `started`, becomes `completed`, and the result screen confirms saving. Verify retries do not add rows. Test both a win and a loss before rollout.

After editing Apps Script, deploy a **new version of the existing deployment** so `/exec` uses the new code. Keep one deployment/project as the writer for a sheet: the [script lock](https://developers.google.com/apps-script/reference/lock) coordinates calls within that project, not separate projects.

## Sheet columns and moderation

`Matches` has one row per run:

`match_id`, `player_id`, `nickname`, `difficulty`, `version`, `provider`, `strategy`, `started_at_ms`, `status`, `completed_at`, `duration_ms`, `human_score`, `jev_score`, `live_decisions`, `fallback_decisions`, `mock_decisions`, `strategy_changed`, `ranked`, `reason`, `hidden`.

Use filter views to inspect data. Do not rename/reorder headers, manually change IDs, or sort/edit rows while games are saving. Set `hidden` to `TRUE` to exclude an abusive or suspicious run. The next-best visible completed run for that browser can take its place. Public responses contain only nickname, match ID, rank, time, score, and completion timestamp, never the private player ID or raw rows. Boards may be cached for up to ten seconds per server instance.

## HTTP API

- `GET /api/leaderboard?difficulty=1|2|3`: top 20 plus the requesting browser's personal best, even when outside the top 20. Default difficulty is Hard (`3`).
- `POST /api/leaderboard/start`: `{clientMatchId, playerName, difficulty, strategy}`. Logs the start and returns a signed ticket, setting the private browser identity cookie if needed.
- `POST /api/leaderboard/finish`: `{ticket, durationMs, humanScore, aiScore, liveDecisions, fallbackDecisions, mockDecisions, strategyChanged}`. Saves once and returns that run's rank plus the refreshed board. Repeating the same result is safe; conflicting replacements are rejected.

All three are same-origin app endpoints, separate from the Fabric/Jev inference endpoint. No gateway re-import is needed. Missing configuration returns 503 with `leaderboard_not_configured`; storage failures are explicit and never masquerade as saved results. The game stays playable without Sheets.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run test:e2e`. Tests use an in-memory fake of the Apps Script spreadsheet API and mock network boundaries, not your live sheet or Jev credits. A real deployment still needs the connection smoke test in step 8 above.
