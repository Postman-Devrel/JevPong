# Supabase leaderboard

Jev Pong has separate Easy, Medium, and Hard boards, anonymous match logging,
and a post-match rank. Supabase stays private: browsers call the existing
Next.js `/api/leaderboard/*` routes, and only those server routes carry the
Supabase secret key.

The Supabase migration is in
[`supabase/migrations/202609220001_jev_leaderboard.sql`](../supabase/migrations/202609220001_jev_leaderboard.sql).
It creates the match table, ranking indexes, Row Level Security configuration,
and transactional database functions used by the app.

## Rules

- First to seven. Completed matches are ordered by match time, rounded to
  hundredths. Time includes countdowns and excludes pauses.
- Only a browser's fastest qualifying result appears for each difficulty.
  Equal times share competition rank (`1, 1, 3`).
- A result qualifies when live Fabric/Jev decisions are at least 70% of all
  recorded decisions. Mock-provider and zero-live runs remain stored but do not
  rank. Losses, fallback decisions, strategy changes, and every strategy are
  allowed.
- Nicknames are public, non-unique, and unverified. A signed HttpOnly cookie
  identifies the browser for one year. Clearing it or changing devices creates
  a new identity.
- `LEADERBOARD_VERSION` partitions seasons. Increment it after material changes
  to physics, difficulty, or model configuration.

## Create and connect Supabase

1. Create a Supabase project. Select the region closest to the deployed Next.js
   server; London is appropriate when the application server is in London.
2. Open **SQL Editor → New query**, paste the complete migration SQL linked
   above, and run it once. Confirm that `public.jev_matches`, the three public
   `jev_leaderboard_*` RPCs, and their board-data helper exist.
3. Open **Settings → API Keys** and create or copy a new server secret beginning
   with `sb_secret_`. Do not use a publishable key. Do not paste the secret into
   chat, source control, screenshots, or any `NEXT_PUBLIC_` variable.
4. Keep the existing `LEADERBOARD_SECRET` used by the Sheets deployment. If
   this is a fresh setup without one, generate an independent signing secret:

   ```sh
   openssl rand -hex 32
   ```

5. Add these variables to `.env.local` and to the deployment's server-side
   environment:

   ```dotenv
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_YOUR_SERVER_SECRET
   LEADERBOARD_SECRET=YOUR_RANDOM_SIGNING_SECRET
   ```

   `LEADERBOARD_SECRET` is not the Supabase key. Keep its current value during
   migration so existing browser identity cookies and in-progress tickets stay
   valid.

6. Restart the app. When both Supabase variables are present, Supabase takes
   precedence over the legacy Google Sheets adapter. A partial or invalid
   Supabase configuration fails closed instead of silently writing to Sheets.

## Import the existing Google Sheet

Perform the cutover while game traffic is paused, otherwise a match could be
written to Sheets after the export.

1. In the Google Sheet, open the `Matches` tab and use **File → Download →
   Comma-separated values (.csv)**.
2. In Supabase, open **Table Editor → jev_matches → Insert → Import data from
   CSV**.
3. Map the existing columns directly:

   `match_id`, `player_id`, `nickname`, `difficulty`, `version`, `provider`,
   `strategy`, `started_at_ms`, `status`, `completed_at`, `duration_ms`,
   `human_score`, `jev_score`, `live_decisions`, `fallback_decisions`,
   `mock_decisions`, `strategy_changed`, `ranked`, `reason`, `hidden`.

   Do not add `created_at`; Postgres supplies it. Empty completion fields on
   abandoned `started` rows should remain `NULL`. Ensure `hidden` is `FALSE`
   when the Sheet cell is blank.

4. Verify the import in SQL Editor:

   ```sql
   select status, count(*) from public.jev_matches group by status;
   select difficulty, count(*)
   from public.jev_matches
   where status = 'completed' and ranked is true and hidden is false
   group by difficulty
   order by difficulty;
   ```

5. Add the Supabase variables and redeploy. Play one match and verify that it is
   inserted, completes on the same row, returns a rank, and appears after a
   refresh.
6. Keep the private Sheet unchanged for rollback until the Supabase deployment
   is verified. Afterwards remove `GOOGLE_SHEETS_LEADERBOARD_URL` from the
   deployment environment. The Apps Script source can remain archived.

## Security and moderation

The table has Row Level Security enabled, and `anon` and `authenticated` have no
table or RPC access. Only the server's secret key maps to `service_role`. The
browser never connects to Supabase directly.

To hide an abusive result without deleting the audit row:

```sql
update public.jev_matches
set hidden = true
where match_id = 'MATCH_ID';
```

The next request recalculates the affected player's best and every competition
rank. To restore it, set `hidden = false`.

This remains a community leaderboard, not cheat-proof competition. Signed
tickets bind identity, level, nickname, provider, strategy, and start time, and
the server validates score shape, duration, origin, request size, and live Jev
share. The browser still reports match results and decision counts. Prizes or
verified tournaments require server-authoritative simulation or validated
replays.

Add a trusted edge/WAF rate limit for `/api/leaderboard/*` before high-volume
launch. The built-in limiter is per application instance.

## HTTP API

- `GET /api/leaderboard?difficulty=1|2|3`: top 20 plus this browser's personal
  best, even when outside the top 20. Omitting `difficulty` defaults to Hard
  (`3`).
- `POST /api/leaderboard/start`: stores an idempotent start and returns a signed
  match ticket.
- `POST /api/leaderboard/finish`: transactionally completes the existing row
  once and returns the run rank, retained personal best, and refreshed board.

The public contract is unchanged from the Google Sheets implementation, so the
game client and Gateway specification need no migration.

## Legacy fallback

If `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are both absent, the app continues
to use `GOOGLE_SHEETS_LEADERBOARD_URL` with `LEADERBOARD_SECRET`. This is only a
cutover safeguard. If either Supabase variable is present but the pair is
invalid, the leaderboard returns `leaderboard_not_configured` and does not fall
back, preventing accidental split writes.

## Verification

Run:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Automated tests exercise the same public API with storage doubles and never use
production Supabase, Google Sheets, or paid Jev requests. Complete the live
smoke test in the import section before removing the Sheet fallback.
