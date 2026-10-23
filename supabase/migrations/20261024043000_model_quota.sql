-- Shared Gemini free-tier ledger.
-- Reuses ai_usage_counters. These period_start values do not collide with the
-- UTC hour/day rows the application budget already writes:
--   Flash day:    bucket day,  Pacific midnight
--   Lite day:     bucket day,  Pacific midnight + 1 second
--   Flash minute: bucket hour, UTC minute + 1 millisecond
--   Lite minute:  bucket hour, UTC minute + 2 milliseconds
-- Flash stores its last attempt in halted_reason on the Flash day row only.
-- This file is the schema change. Applying it to production is a separate operator step.

create or replace function ai_reserve_model_attempt(p_tier text, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text := lower(btrim(coalesce(p_tier, '')));
  v_now timestamptz := coalesce(p_now, now());
  v_day timestamptz := (date_trunc('day', v_now at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles');
  v_day_at timestamptz;
  v_minute_at timestamptz;
  v_day_cap integer;
  v_rpm integer;
  v_gap interval := interval '0 seconds';
  v_day_count integer;
  v_minute_count integer;
  v_last text;
  v_last_at timestamptz;
begin
  if v_tier = 'flash' then
    v_day_cap := 20;
    v_rpm := 5;
    v_gap := interval '72 minutes';
    v_day_at := v_day;
    v_minute_at := date_trunc('minute', v_now) + interval '1 millisecond';
  elsif v_tier = 'lite' then
    v_day_cap := 500;
    v_rpm := 15;
    v_gap := interval '0 seconds';
    v_day_at := v_day + interval '1 second';
    v_minute_at := date_trunc('minute', v_now) + interval '2 milliseconds';
  else
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  insert into ai_usage_counters (bucket, period_start)
  values ('day', v_day_at)
  on conflict (bucket, period_start) do nothing;

  insert into ai_usage_counters (bucket, period_start)
  values ('hour', v_minute_at)
  on conflict (bucket, period_start) do nothing;

  select invocations, halted_reason
    into v_day_count, v_last
  from ai_usage_counters
  where bucket = 'day' and period_start = v_day_at
  for update;

  select invocations
    into v_minute_count
  from ai_usage_counters
  where bucket = 'hour' and period_start = v_minute_at
  for update;

  if v_day_count is null or v_minute_count is null then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  if v_day_count >= v_day_cap then
    return jsonb_build_object('ok', false, 'code', 'day', 'attempts', v_day_count, 'minuteAttempts', v_minute_count);
  end if;

  if v_tier = 'flash' and v_last is not null and btrim(v_last) <> '' then
    begin
      v_last_at := (btrim(v_last)::timestamp at time zone 'UTC');
    exception
      when others then
        return jsonb_build_object('ok', false, 'code', 'invalid');
    end;
    if v_now < v_last_at + v_gap then
      return jsonb_build_object(
        'ok', false,
        'code', 'spacing',
        'attempts', v_day_count,
        'minuteAttempts', v_minute_count,
        'retryAt', v_last_at + v_gap
      );
    end if;
  end if;

  if v_minute_count >= v_rpm then
    return jsonb_build_object('ok', false, 'code', 'rpm', 'attempts', v_day_count, 'minuteAttempts', v_minute_count);
  end if;

  update ai_usage_counters
  set
    invocations = invocations + 1,
    halted_reason = case
      when v_tier = 'flash' then to_char(v_now at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')
      else halted_reason
    end
  where bucket = 'day' and period_start = v_day_at;

  update ai_usage_counters
  set invocations = invocations + 1
  where bucket = 'hour' and period_start = v_minute_at;

  return jsonb_build_object(
    'ok', true,
    'tier', v_tier,
    'attempts', v_day_count + 1,
    'minuteAttempts', v_minute_count + 1
  );
end;
$$;

create or replace function ai_close_model_day(p_tier text, p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text := lower(btrim(coalesce(p_tier, '')));
  v_now timestamptz := coalesce(p_now, now());
  v_day timestamptz := (date_trunc('day', v_now at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles');
  v_at timestamptz;
  v_cap integer;
begin
  if v_tier = 'flash' then
    v_at := v_day;
    v_cap := 20;
  elsif v_tier = 'lite' then
    v_at := v_day + interval '1 second';
    v_cap := 500;
  else
    return;
  end if;

  insert into ai_usage_counters (bucket, period_start, invocations)
  values ('day', v_at, v_cap)
  on conflict (bucket, period_start) do update
    set invocations = greatest(ai_usage_counters.invocations, excluded.invocations);
end;
$$;

-- A mind run can last about 200 seconds. The previous 2 minute lease could expire mid-run.
create or replace function ai_claim_citizens(p_run uuid, p_limit integer, p_interval interval)
returns table (claimed_citizen_id uuid, token_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select s.citizen_id
    from citizen_world_state s
    left join ai_citizen_claims c on c.citizen_id = s.citizen_id
    where s.activity <> 'unavailable'
      and not exists (
        select 1 from world_intents i
        where i.citizen_id = s.citizen_id and i.status = 'pending'
      )
      and (c.last_decision_at is null or c.last_decision_at < now() - p_interval)
      and (c.claimed_until is null or c.claimed_until < now())
    order by c.last_decision_at nulls first, s.citizen_id
    limit greatest(0, least(coalesce(p_limit, 0), 8))
    for update of s skip locked
  ), claimed as (
    insert into ai_citizen_claims (citizen_id, run_id, claimed_until)
    select picked.citizen_id, p_run, now() + interval '4 minutes'
    from picked
    on conflict (citizen_id) do update
      set run_id = excluded.run_id,
          claimed_until = excluded.claimed_until
      where ai_citizen_claims.claimed_until is null
         or ai_citizen_claims.claimed_until < now()
    returning ai_citizen_claims.citizen_id
  )
  select claimed.citizen_id, z.token_id::text
  from claimed
  join citizens z on z.id = claimed.citizen_id
  order by z.token_id;
end;
$$;

revoke all on function ai_reserve_model_attempt(text, timestamptz) from public;
revoke all on function ai_close_model_day(text, timestamptz) from public;
revoke all on function ai_reserve_model_attempt(text, timestamptz) from anon, authenticated;
revoke all on function ai_close_model_day(text, timestamptz) from anon, authenticated;
grant execute on function ai_reserve_model_attempt(text, timestamptz) to service_role;
grant execute on function ai_close_model_day(text, timestamptz) to service_role;
