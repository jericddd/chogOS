-- Phase 6a: allow the nft_bound_v1 citizen account scheme.
-- Additive only. This file does not insert wallets, predict addresses, or
-- mark anything deployed. It is not applied to hosted Supabase in Phase 6a.

alter table citizen_wallet_registry
  drop constraint citizen_wallet_registry_scheme_check;

alter table citizen_wallet_registry
  add constraint citizen_wallet_registry_scheme_check
  check (scheme in ('unassigned', 'nft_bound_v1'));

alter table citizen_wallet_registry
  drop constraint citizen_wallet_registry_account_type_check;

alter table citizen_wallet_registry
  add constraint citizen_wallet_registry_account_type_check
  check (account_type in ('none', 'safe', 'erc6551', 'unknown', 'nft_bound'));

comment on constraint citizen_wallet_registry_scheme_check on citizen_wallet_registry is
  'unassigned is the production placeholder. nft_bound_v1 is the Phase 6a account scheme and is not written until a verified deployment exists.';
