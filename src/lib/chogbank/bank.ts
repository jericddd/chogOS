import { getAddress } from "viem";

/** Deployed ChogBank on Monad mainnet. A public address, not a signer. */
export const MAINNET_CHOG_BANK = getAddress("0xB2494538433B2FA3167A723d32329cc22c3A59C1");

/** Immutable authorizer. A public address, not a key. */
export const MAINNET_CHOG_BANK_AUTHORIZER = getAddress("0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04");

/** Gas payer for ChogBank.distribute. This is not the authorizer and not the wallet agent. */
export const MAINNET_PAYOUT_GAS = getAddress("0x40C20bF79Eed165D8Ac4970ccE7e257B63D2A806");

/** Block that created ChogBank. Log scans start here. */
export const CHOG_BANK_DEPLOYMENT_BLOCK = 115_672_361n;

/** Immutable constructor caps. A larger application review limit cannot be paid. */
export const CHAIN_MON_PER_TX = 10_000_000_000_000_000n;
export const CHAIN_MON_CITIZEN = 50_000_000_000_000_000n;
export const CHAIN_MON_AGGREGATE = 50_000_000_000_000_000n;
export const CHAIN_CHOG_CAP = 1n;
export const CHAIN_WINDOW_SECONDS = 86_400n;
export const CHAIN_AUTHORIZATION_TTL = 3_600n;

/** Fifteen minutes. The contract accepts a deadline up to the authorization TTL. */
export const PAYOUT_DEADLINE_SECONDS = 900n;

/** Room for one distribution at the base-fee floor before another signature. */
export const PAYOUT_GAS_RESERVE_WEI = 50_000_000_000_000_000n;
