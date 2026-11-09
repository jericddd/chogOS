-- Routine simulation lines were most of civilization_events (1.5 GB, all sealed).
-- The sealed history stays. New rows for the same citizen and kind are kept
-- once per real day. Meetings still advance a bond on every meeting.
-- Work, construction, AI, and chain events are unchanged.

create table if not exists world_event_quiet (
  citizen_id uuid not null references citizens (id) on delete cascade,
  kind text not null,
  related_id uuid not null,
  quiet_until timestamptz not null,
  primary key (citizen_id, kind, related_id)
);

comment on table world_event_quiet is
  'One routine simulation event per citizen, kind, and partner per real day. Does not store the event text.';

revoke all on table world_event_quiet from public, anon, authenticated;
grant select, insert, update, delete on table world_event_quiet to service_role;

create or replace function world_record_event(
  p_dedupe text,
  p_kind text,
  p_category text,
  p_source text,
  p_summary text,
  p_citizen uuid,
  p_building text,
  p_related uuid,
  p_occurred timestamptz,
  p_world bigint,
  p_tick bigint,
  p_payload jsonb,
  p_intent uuid default null,
  p_decision uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_id uuid;
  v_related uuid := coalesce(p_related, '00000000-0000-0000-0000-000000000000'::uuid);
  v_until timestamptz;
  v_quiet boolean := p_source = 'simulation'
    and p_citizen is not null
    and p_kind in (
      'movement.arrived_home',
      'citizen.sleep',
      'citizen.market_visit',
      'citizen.idle',
      'social.met',
      'social.gathered'
    );
begin
  if v_quiet then
    select quiet_until into v_until
    from world_event_quiet
    where citizen_id = p_citizen and kind = p_kind and related_id = v_related;
    if v_until is not null and v_until > now() then
      if p_kind = 'social.met' and p_related is not null then
        perform world_progress_bond(p_citizen, p_related);
      end if;
      return null;
    end if;
  end if;

  if p_citizen is not null then
    v_payload := v_payload || jsonb_build_object(
      'tokenId', (select token_id::text from citizens where id = p_citizen)
    );
  end if;
  if p_related is not null then
    v_payload := v_payload || jsonb_build_object(
      'relatedTokenId', (select token_id::text from citizens where id = p_related)
    );
  end if;
  if p_building is not null then
    v_payload := v_payload || jsonb_build_object('buildingName', world_building_name(p_building));
  end if;
  if p_intent is not null then
    v_payload := v_payload || jsonb_build_object('intentId', p_intent);
  end if;
  if p_decision is not null then
    v_payload := v_payload || jsonb_build_object('decisionId', p_decision);
  end if;

  insert into civilization_events (
    dedupe_key, kind, category, source, summary, actor_citizen_id, building_id,
    related_citizen_id, occurred_at, world_s, tick_seq, chain_status, payload, schema_version,
    intent_id, decision_id
  )
  values (
    p_dedupe, p_kind, p_category, p_source, p_summary, p_citizen, p_building,
    p_related, p_occurred, p_world, p_tick, 'offchain', v_payload, 1,
    p_intent, p_decision
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_quiet and v_id is not null then
    insert into world_event_quiet (citizen_id, kind, related_id, quiet_until)
    values (p_citizen, p_kind, v_related, now() + interval '1 day')
    on conflict (citizen_id, kind, related_id)
    do update set quiet_until = excluded.quiet_until;
  end if;

  return v_id;
end;
$$;

revoke all on function world_record_event(text, text, text, text, text, uuid, text, uuid, timestamptz, bigint, bigint, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function world_record_event(text, text, text, text, text, uuid, text, uuid, timestamptz, bigint, bigint, jsonb, uuid, uuid) to service_role;
