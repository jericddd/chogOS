-- Phase 1: founding citizens, genesis roster, enrollment challenges, and sync logs.
-- Ownership in these tables is a snapshot. Current ownership is ownerOf on Monad.
-- Token ids are discovered from the NFT contract. This migration does not seed them.

update civilization_state
set
  name = 'chogOS',
  summary = 'Genesis phase. Founding citizens are Chog Genesis NFTs verified in the ChogTreasury wallet. The AI mind is not active.'
where singleton = true;

alter table citizens
  add column origin text not null default 'community'
    check (origin in ('founding_treasury', 'community')),
  add column founding_membership_active boolean not null default false,
  add column civilization_singleton boolean not null default true
    references civilization_state (singleton),
  add column metadata_name text,
  add column metadata_description text,
  add column metadata_image text,
  add column metadata_status text not null default 'missing'
    check (metadata_status in ('missing', 'fetched', 'unavailable')),
  add column metadata_checked_at timestamptz,
  add column future_attributes jsonb not null default '{}'::jsonb;

comment on column citizens.origin is
  'How this citizen first entered the shared civilization. One row per NFT identity.';

comment on column citizens.founding_membership_active is
  'True only while a verified ownerOf read says ChogTreasury currently holds the NFT.';

comment on column citizens.future_attributes is
  'Reserved for occupation, social status, goals, and a future personal wallet. Phase 1 does not invent these.';

comment on column citizens.civilization_singleton is
  'Every citizen belongs to the single civilization row.';

create table genesis_roster (
  citizen_id uuid primary key references citizens (id) on delete cascade,
  treasury_address text not null check (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  membership_active boolean not null,
  verification_status text not null
    check (verification_status in ('verified', 'stale')),
  first_verified_at timestamptz not null,
  last_verified_at timestamptz,
  left_treasury_at timestamptz
);

comment on table genesis_roster is
  'Treasury membership for a citizen. Stale means a refresh could not recheck ownerOf. Stale does not drop membership by itself.';

create table ownership_snapshots (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  block_number bigint not null,
  source text not null check (source in ('ownerOf')),
  observed_at timestamptz not null default now()
);

create index ownership_snapshots_citizen_block
  on ownership_snapshots (citizen_id, block_number desc);

create table enrollment_challenges (
  id uuid primary key default gen_random_uuid(),
  address text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  nonce text not null unique,
  message text not null,
  token_ids jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index enrollment_challenges_address
  on enrollment_challenges (address, created_at desc);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('genesis_treasury')),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  block_number bigint,
  verified_count integer,
  error text,
  detail jsonb not null default '{}'::jsonb
);

create unique index sync_runs_one_running_genesis
  on sync_runs (kind)
  where status = 'running';

create index sync_runs_finished
  on sync_runs (kind, finished_at desc);

alter table civilization_events
  add column dedupe_key text unique;

comment on column civilization_events.dedupe_key is
  'Prevents a repeated sync at the same block from writing the same event twice.';

create index citizens_founding_membership
  on citizens (founding_membership_active, origin);

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'genesis_roster',
    'ownership_snapshots',
    'enrollment_challenges',
    'sync_runs'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
      end if;
    end loop;
  end loop;
end $$;
