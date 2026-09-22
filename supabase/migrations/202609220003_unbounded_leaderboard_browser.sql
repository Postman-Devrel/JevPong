-- Fix the page RPC response contract and page through the complete leaderboard.

create or replace function public.jev_leaderboard_page(
  p_difficulty integer,
  p_query text,
  p_offset integer,
  p_limit integer,
  p_version text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      lower(left(trim(coalesce(p_query, '')), 18)) as query,
      greatest(0, least(coalesce(p_offset, 0), 10000000)) as page_offset,
      greatest(1, least(coalesce(p_limit, 50), 50)) as page_limit
  ),
  personal_bests as materialized (
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
  eligible as materialized (
    select p.*
    from placed as p
    cross join params as x
    where x.query = '' or position(x.query in lower(p.nickname)) > 0
  ),
  page_entries as (
    select jsonb_agg(
      jsonb_build_object(
        'matchId', e.match_id,
        'playerName', e.nickname,
        'rank', e.competition_rank,
        'durationMs', e.duration_ms,
        'humanScore', e.human_score,
        'aiScore', e.jev_score,
        'completedAt', e.completed_at
      ) order by e.display_order
    ) as entries
    from (
      select e.*
      from eligible as e
      cross join params as x
      order by e.display_order
      offset (select page_offset from params)
      limit (select page_limit from params)
    ) as e
  )
  select jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'difficulty', p_difficulty,
      'entries', coalesce((select p.entries from page_entries as p), '[]'::jsonb),
      'totalPlayers', (select count(*)::integer from placed),
      'matchingPlayers', (select count(*)::integer from eligible),
      'nextOffset', (
        select case
          when count(*) > x.page_offset + x.page_limit
            then x.page_offset + x.page_limit
          else null
        end
        from eligible
        cross join params as x
        group by x.page_offset, x.page_limit
      ),
      'query', (select query from params),
      'updatedAt', clock_timestamp()
    )
  );
$$;

revoke all on function public.jev_leaderboard_page(integer, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.jev_leaderboard_page(integer, text, integer, integer, text)
  to service_role;
