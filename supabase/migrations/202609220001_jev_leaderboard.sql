-- Jev Pong leaderboard storage and transactional ranking API.
-- Run this migration in the Supabase SQL editor before configuring the app.

create table if not exists public.jev_matches (
  match_id text primary key,
  player_id uuid not null,
  nickname text not null,
  difficulty smallint not null,
  version text not null,
  provider text not null,
  strategy text not null,
  started_at_ms bigint not null,
  status text not null default 'started',
  completed_at timestamptz,
  duration_ms integer,
  human_score smallint,
  jev_score smallint,
  live_decisions integer,
  fallback_decisions integer,
  mock_decisions integer,
  strategy_changed boolean,
  ranked boolean,
  reason text,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  constraint jev_matches_match_id check (match_id ~ '^[A-Za-z0-9_-]{43}$'),
  constraint jev_matches_nickname check (
    char_length(nickname) between 1 and 18
    and left(nickname, 1) not in ('=', '+', '@', '-')
    and nickname !~ E'[\\t\\r\\n]'
  ),
  constraint jev_matches_difficulty check (difficulty in (1, 2, 3)),
  constraint jev_matches_version check (version ~ '^[A-Za-z0-9-]{1,80}$'),
  constraint jev_matches_provider check (provider in ('jev', 'mock')),
  constraint jev_matches_strategy check (
    strategy in ('balanced', 'aggressive', 'defensive')
  ),
  constraint jev_matches_status check (status in ('started', 'completed')),
  constraint jev_matches_duration check (
    duration_ms is null or duration_ms between 1 and 7200000
  ),
  constraint jev_matches_scores check (
    (human_score is null or human_score between 0 and 7)
    and (jev_score is null or jev_score between 0 and 7)
  ),
  constraint jev_matches_decisions check (
    (live_decisions is null or live_decisions between 0 and 100000)
    and (fallback_decisions is null or fallback_decisions between 0 and 100000)
    and (mock_decisions is null or mock_decisions between 0 and 100000)
  ),
  constraint jev_matches_reason check (
    reason is null or reason in (
      'loss',
      'practice',
      'fallback',
      'strategy',
      'no_live_decisions',
      'insufficient_live_decisions',
      'hidden'
    )
  )
);

create index if not exists jev_matches_public_board_idx
  on public.jev_matches (
    version,
    difficulty,
    duration_ms,
    completed_at,
    match_id
  )
  where status = 'completed' and ranked is true and hidden is false;

create index if not exists jev_matches_player_best_idx
  on public.jev_matches (
    player_id,
    version,
    difficulty,
    duration_ms,
    completed_at,
    match_id
  )
  where status = 'completed' and ranked is true and hidden is false;

alter table public.jev_matches enable row level security;
revoke all on table public.jev_matches from public, anon, authenticated;
grant select, insert, update on table public.jev_matches to service_role;

create or replace function public.jev_leaderboard_board_data(
  p_difficulty integer,
  p_player_id uuid,
  p_version text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with personal_bests as materialized (
    select distinct on (m.player_id)
      m.match_id,
      m.player_id,
      m.nickname,
      m.duration_ms,
      m.human_score,
      m.jev_score,
      m.completed_at
    from public.jev_matches as m
    where m.status = 'completed'
      and m.ranked is true
      and m.hidden is false
      and m.difficulty = p_difficulty
      and m.version = p_version
    order by
      m.player_id,
      m.duration_ms,
      m.completed_at,
      m.match_id
  ),
  placed as (
    select
      b.*,
      rank() over (order by b.duration_ms)::integer as competition_rank,
      row_number() over (
        order by b.duration_ms, b.completed_at, b.match_id
      )::integer as display_order
    from personal_bests as b
  ),
  top_entries as (
    select jsonb_agg(
      jsonb_build_object(
        'matchId', p.match_id,
        'playerName', p.nickname,
        'rank', p.competition_rank,
        'durationMs', p.duration_ms,
        'humanScore', p.human_score,
        'aiScore', p.jev_score,
        'completedAt', p.completed_at
      ) order by p.display_order
    ) as entries
    from placed as p
    where p.display_order <= 20
  )
  select jsonb_build_object(
    'difficulty', p_difficulty,
    'entries', coalesce((select t.entries from top_entries as t), '[]'::jsonb),
    'totalPlayers', (select count(*)::integer from placed),
    'personalBest', (
      select jsonb_build_object(
        'matchId', p.match_id,
        'playerName', p.nickname,
        'rank', p.competition_rank,
        'durationMs', p.duration_ms,
        'humanScore', p.human_score,
        'aiScore', p.jev_score,
        'completedAt', p.completed_at
      )
      from placed as p
      where p.player_id = p_player_id
    ),
    'updatedAt', clock_timestamp()
  );
$$;

create or replace function public.jev_leaderboard_board(
  p_difficulty integer,
  p_player_id uuid,
  p_version text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'data', public.jev_leaderboard_board_data(
      p_difficulty,
      p_player_id,
      p_version
    )
  );
$$;

create or replace function public.jev_leaderboard_start(
  p_match_id text,
  p_player_id uuid,
  p_player_name text,
  p_difficulty integer,
  p_version text,
  p_provider text,
  p_strategy text,
  p_started_at_ms bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_match public.jev_matches%rowtype;
begin
  insert into public.jev_matches (
    match_id,
    player_id,
    nickname,
    difficulty,
    version,
    provider,
    strategy,
    started_at_ms,
    status,
    hidden
  ) values (
    p_match_id,
    p_player_id,
    p_player_name,
    p_difficulty,
    p_version,
    p_provider,
    p_strategy,
    p_started_at_ms,
    'started',
    false
  )
  on conflict (match_id) do nothing;

  select m.* into v_match
  from public.jev_matches as m
  where m.match_id = p_match_id;

  if v_match.player_id <> p_player_id
    or v_match.difficulty <> p_difficulty
    or v_match.version <> p_version
    or v_match.nickname <> p_player_name then
    return jsonb_build_object('ok', false, 'error', 'result_conflict');
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'matchId', v_match.match_id,
      'playerId', v_match.player_id,
      'playerName', v_match.nickname,
      'difficulty', v_match.difficulty,
      'version', v_match.version,
      'provider', v_match.provider,
      'strategy', v_match.strategy,
      'startedAt', v_match.started_at_ms
    )
  );
end;
$$;

create or replace function public.jev_leaderboard_finish(
  p_match_id text,
  p_player_id uuid,
  p_player_name text,
  p_difficulty integer,
  p_version text,
  p_provider text,
  p_strategy text,
  p_started_at_ms bigint,
  p_completed_at timestamptz,
  p_duration_ms integer,
  p_human_score integer,
  p_ai_score integer,
  p_live_decisions integer,
  p_fallback_decisions integer,
  p_mock_decisions integer,
  p_strategy_changed boolean,
  p_ranked boolean,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_match public.jev_matches%rowtype;
  v_board jsonb;
  v_rank integer;
  v_is_ranked boolean;
begin
  select m.* into v_match
  from public.jev_matches as m
  where m.match_id = p_match_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'match_missing');
  end if;

  if v_match.player_id <> p_player_id
    or v_match.difficulty <> p_difficulty
    or v_match.version <> p_version
    or v_match.nickname <> p_player_name then
    return jsonb_build_object('ok', false, 'error', 'result_conflict');
  end if;

  if v_match.status = 'completed' then
    if v_match.duration_ms is distinct from p_duration_ms
      or v_match.human_score is distinct from p_human_score
      or v_match.jev_score is distinct from p_ai_score
      or v_match.live_decisions is distinct from p_live_decisions
      or v_match.fallback_decisions is distinct from p_fallback_decisions
      or v_match.mock_decisions is distinct from p_mock_decisions
      or v_match.strategy_changed is distinct from p_strategy_changed then
      return jsonb_build_object('ok', false, 'error', 'result_conflict');
    end if;
  else
    update public.jev_matches as m
    set
      status = 'completed',
      completed_at = p_completed_at,
      duration_ms = p_duration_ms,
      human_score = p_human_score,
      jev_score = p_ai_score,
      live_decisions = p_live_decisions,
      fallback_decisions = p_fallback_decisions,
      mock_decisions = p_mock_decisions,
      strategy_changed = p_strategy_changed,
      ranked = p_ranked,
      reason = p_reason
    where m.match_id = p_match_id
    returning m.* into v_match;
  end if;

  v_is_ranked := v_match.ranked is true and v_match.hidden is false;
  v_board := public.jev_leaderboard_board_data(
    v_match.difficulty,
    v_match.player_id,
    v_match.version
  );

  if v_is_ranked then
    with other_personal_bests as (
      select distinct on (m.player_id)
        m.player_id,
        m.duration_ms
      from public.jev_matches as m
      where m.status = 'completed'
        and m.ranked is true
        and m.hidden is false
        and m.difficulty = v_match.difficulty
        and m.version = v_match.version
        and m.player_id <> v_match.player_id
      order by
        m.player_id,
        m.duration_ms,
        m.completed_at,
        m.match_id
    )
    select 1 + count(*)::integer into v_rank
    from other_personal_bests as b
    where b.duration_ms < v_match.duration_ms;
  else
    v_rank := null;
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'matchId', v_match.match_id,
      'ranked', v_is_ranked,
      'reason', case
        when v_match.hidden then 'hidden'
        else nullif(v_match.reason, '')
      end,
      'rank', v_rank,
      'personalBest', coalesce(
        v_board #>> '{personalBest,matchId}' = v_match.match_id,
        false
      ),
      'durationMs', v_match.duration_ms,
      'board', v_board
    )
  );
end;
$$;

revoke all on function public.jev_leaderboard_board_data(integer, uuid, text)
  from public, anon, authenticated;
revoke all on function public.jev_leaderboard_board(integer, uuid, text)
  from public, anon, authenticated;
revoke all on function public.jev_leaderboard_start(
  text, uuid, text, integer, text, text, text, bigint
) from public, anon, authenticated;
revoke all on function public.jev_leaderboard_finish(
  text, uuid, text, integer, text, text, text, bigint, timestamptz,
  integer, integer, integer, integer, integer, integer, boolean, boolean, text
) from public, anon, authenticated;

grant execute on function public.jev_leaderboard_board_data(integer, uuid, text)
  to service_role;
grant execute on function public.jev_leaderboard_board(integer, uuid, text)
  to service_role;
grant execute on function public.jev_leaderboard_start(
  text, uuid, text, integer, text, text, text, bigint
) to service_role;
grant execute on function public.jev_leaderboard_finish(
  text, uuid, text, integer, text, text, text, bigint, timestamptz,
  integer, integer, integer, integer, integer, integer, boolean, boolean, text
) to service_role;
