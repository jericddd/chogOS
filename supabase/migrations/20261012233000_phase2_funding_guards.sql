-- Phase 2 follow-up. Apply after 20261012220000_phase2_wallets.sql.
-- Makes wallet addresses and funding hashes unique without regard to letter case.
-- Does not insert citizens, token ids, or a treasury address.

create or replace function prevent_wallet_address_replacement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'civilization_treasuries' then
    if old.address is not null and new.address is distinct from old.address then
      raise exception 'treasury address cannot be replaced';
    end if;
    return new;
  end if;
  if old.predicted_address is not null and new.predicted_address is distinct from old.predicted_address then
    raise exception 'predicted address cannot be replaced';
  end if;
  if old.account_address is not null and new.account_address is distinct from old.account_address then
    raise exception 'account address cannot be replaced';
  end if;
  return new;
end;
$$;

drop index if exists citizen_wallet_predicted_address;
create unique index citizen_wallet_predicted_address
  on citizen_wallet_registry (chain_id, lower(predicted_address))
  where predicted_address is not null;

drop index if exists citizen_wallet_account_address;
create unique index citizen_wallet_account_address
  on citizen_wallet_registry (chain_id, lower(account_address))
  where account_address is not null;

drop index if exists treasury_funding_once;
create unique index treasury_funding_once
  on treasury_funding (chain_id, lower(tx_hash), asset_kind, lower(coalesce(token_address, '')));

revoke all on function prevent_wallet_address_replacement() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on function prevent_wallet_address_replacement() from %I', role_name);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
