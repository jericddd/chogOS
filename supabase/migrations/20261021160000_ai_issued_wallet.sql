-- Allow the permanent AI-issued wallet scheme.
-- Additive only. This file does not insert wallets, predict addresses,
-- or mark anything deployed. nft_bound_v1 stays available for historical rows.
-- It is not applied to hosted Supabase by this change.

alter table citizen_wallet_registry
  drop constraint citizen_wallet_registry_scheme_check;

alter table citizen_wallet_registry
  add constraint citizen_wallet_registry_scheme_check
  check (scheme in ('unassigned', 'nft_bound_v1', 'ai_issued_v3'));

comment on constraint citizen_wallet_registry_scheme_check on citizen_wallet_registry is
  'unassigned is the production placeholder. nft_bound_v1 is historical and follows ownerOf. ai_issued_v3 is the permanent AI-issued wallet and does not follow the NFT holder. No row is inserted by this migration.';
