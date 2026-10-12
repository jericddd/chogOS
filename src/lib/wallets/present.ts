import { formatUnits } from "viem";
import { formatUtc } from "@/lib/civilization/labels";
import type { FundingStatus } from "@/lib/wallets/funding";
import { describeNftWalletAuthority, walletStatusCopy, type TreasuryVerification, type WalletAssignment, type WalletStatus } from "@/lib/wallets/lifecycle";
import type { StoredFunding, StoredTreasury } from "@/lib/wallets/store";

export type BalanceLine = {
  symbol: string;
  text: string;
  note: string;
};

export type FundingLine = {
  id: string;
  txHash: string;
  status: FundingStatus;
  summary: string;
};

export type CivilizationTreasuryView = {
  chainLabel: string;
  chogTreasuryAddress: string;
  persistence: "ready" | "not_persisted" | "migration_pending" | "unavailable";
  persistenceDetail: string;
  configured: boolean;
  address: string | null;
  statusLabel: string;
  accountLabel: string;
  verificationLabel: string;
  detail: string | null;
  balances: BalanceLine[];
  funding: FundingLine[];
  fundingNote: string | null;
  setup: string;
};

export type BalanceReading =
  | { state: "unconfigured" }
  | {
      state: "unavailable";
      detail: string;
      lastKnown: { symbol: string; amountRaw: string; decimals: number; observedAt: string; blockNumber: string } | null;
    }
  | { state: "live"; symbol: string; amountRaw: string; decimals: number; observedAt: string; blockNumber: string };

export function formatTokenAmount(amountRaw: string, decimals: number, symbol: string): string {
  try {
    return `${formatUnits(BigInt(amountRaw), decimals)} ${symbol}`;
  } catch {
    return `${amountRaw} raw ${symbol}`;
  }
}

export function treasuryVerificationLabel(verification: TreasuryVerification): string {
  if (verification === "safe_proxy") {
    return "Safe proxy observed. chogOS did not deploy it, and it is not labeled an official treasury.";
  }
  if (verification === "observed") {
    return "Address observed on the configured chain. It is not labeled an official chogOS treasury.";
  }
  return "Not checked. It is not an official chogOS treasury.";
}

function balanceLine(symbol: string, reading: BalanceReading): BalanceLine {
  if (reading.state === "unconfigured") {
    return {
      symbol,
      text: "Not read",
      note: "The civilization treasury has no address, so no balance is shown.",
    };
  }
  if (reading.state === "live") {
    return {
      symbol,
      text: formatTokenAmount(reading.amountRaw, reading.decimals, symbol),
      note: `Live reading at block ${reading.blockNumber}, ${formatUtc(reading.observedAt)}. This is not a promise that the amount can be spent.`,
    };
  }
  const stale = reading.lastKnown
    ? ` Last known ${formatTokenAmount(reading.lastKnown.amountRaw, reading.lastKnown.decimals, symbol)} at block ${reading.lastKnown.blockNumber}, ${formatUtc(reading.lastKnown.observedAt)}. That reading is stale.`
    : " No earlier reading is stored.";
  return {
    symbol,
    text: "Unavailable",
    note: `${reading.detail}${stale}`,
  };
}

export function presentCivilizationTreasury(input: {
  chainId: 143 | 10143;
  chogTreasury: string;
  persistence: CivilizationTreasuryView["persistence"];
  persistenceDetail?: string;
  treasury: StoredTreasury | null;
  native: BalanceReading;
  chog: BalanceReading;
  funding: StoredFunding[];
  fundingNote?: string | null;
}): CivilizationTreasuryView {
  const chainLabel = input.chainId === 143 ? "Monad mainnet · chain 143" : "Monad testnet · chain 10143";
  const configured = input.persistence === "ready" && input.treasury?.status === "configured" && Boolean(input.treasury.address);
  const persistenceDetail =
    input.persistence === "not_persisted"
      ? "Supabase is not configured, so treasury settings are not stored."
      : input.persistence === "migration_pending"
        ? "The Phase 2 tables are not in the database yet. No treasury address is assumed."
        : input.persistence === "unavailable"
          ? (input.persistenceDetail ?? "The treasury record could not be read.")
          : "Treasury settings are read from the existing Supabase project.";

  return {
    chainLabel,
    chogTreasuryAddress: input.chogTreasury,
    persistence: input.persistence,
    persistenceDetail,
    configured,
    address: configured ? input.treasury?.address ?? null : null,
    statusLabel: configured ? "Address configured" : "Treasury not configured",
    accountLabel: configured ? accountLabel(input.treasury) : "No wallet type",
    verificationLabel: configured && input.treasury ? treasuryVerificationLabel(input.treasury.verification) : "Not checked",
    detail: input.treasury?.detail ?? null,
    balances: [balanceLine("MON", input.native), balanceLine("CHOG", input.chog)],
    funding: input.funding.map((row) => ({
      id: row.id,
      txHash: row.txHash,
      status: row.status,
      summary: fundingSummary(row),
    })),
    fundingNote: input.fundingNote ?? null,
    setup: configured
      ? "Funds sent to this address can be checked with a transaction hash. The application does not send funds."
      : "No civilization treasury address is stored. Do not send funds to the ChogTreasury NFT wallet and expect them to appear here.",
  };
}

function accountLabel(treasury: StoredTreasury | null): string {
  if (!treasury) {
    return "No wallet type";
  }
  if (treasury.accountType === "eoa") {
    return "Externally owned account observed";
  }
  if (treasury.accountType === "contract" && treasury.safeVersion) {
    return `Contract · ${treasury.safeVersion}`;
  }
  if (treasury.accountType === "contract") {
    return "Contract observed";
  }
  return "Wallet type not verified";
}

function fundingSummary(row: StoredFunding): string {
  const amount =
    row.amountRaw && row.decimals !== null ? formatTokenAmount(row.amountRaw, row.decimals, row.symbol) : "Amount not recorded";
  const when = row.blockNumber ? `block ${row.blockNumber}` : "no block";
  return `${row.status} · ${amount} · ${when}. ${row.detail ?? ""}`.trim();
}

export type CitizenWalletView = {
  statusText: string;
  addressLabel: string | null;
  address: string | null;
  authority: string;
  note: string;
};

export function presentCitizenWallet(input: {
  citizenId: string | null;
  assignment: WalletAssignment | null;
  persistence: CivilizationTreasuryView["persistence"];
  detail?: string;
}): CitizenWalletView {
  const authority = describeNftWalletAuthority();
  if (!input.citizenId) {
    return {
      statusText: "No wallet record",
      addressLabel: null,
      address: null,
      authority,
      note: "This citizen is not persisted, so no wallet assignment exists.",
    };
  }
  if (input.persistence === "not_persisted") {
    return {
      statusText: "No wallet record",
      addressLabel: null,
      address: null,
      authority,
      note: "Supabase is not configured, so citizen wallets are not stored.",
    };
  }
  if (input.persistence === "migration_pending") {
    return {
      statusText: "No wallet record",
      addressLabel: null,
      address: null,
      authority,
      note: "The Phase 2 wallet table is not in the database yet. No address has been predicted or deployed.",
    };
  }
  if (input.persistence === "unavailable") {
    return {
      statusText: "Wallet record unavailable",
      addressLabel: null,
      address: null,
      authority,
      note: input.detail ?? "The wallet record could not be read.",
    };
  }
  if (!input.assignment) {
    return {
      statusText: walletStatusCopy(null),
      addressLabel: null,
      address: null,
      authority,
      note: "No assignment is stored for this citizen on the configured chain.",
    };
  }
  return {
    statusText: walletStatusCopy(input.assignment.status),
    addressLabel: addressLabelFor(input.assignment.status),
    address: displayAddress(input.assignment),
    authority,
    note: assignmentNote(input.assignment.status),
  };
}

function addressLabelFor(status: WalletStatus): string | null {
  if (status === "address_predicted" || status === "deployment_pending") {
    return "Predicted address";
  }
  if (status === "deployed" || status === "verified") {
    return "Account address";
  }
  return null;
}

function displayAddress(assignment: WalletAssignment): string | null {
  if (assignment.status === "deployed" || assignment.status === "verified") {
    return assignment.accountAddress;
  }
  if (assignment.status === "address_predicted" || assignment.status === "deployment_pending") {
    return assignment.predictedAddress;
  }
  return null;
}

function assignmentNote(status: WalletStatus): string {
  if (status === "address_predicted" || status === "deployment_pending") {
    return "A predicted address is not a deployed account.";
  }
  if (status === "deployed") {
    return "Code was observed. That is not full verification, and chogOS has not been given spending authority.";
  }
  if (status === "verified") {
    return "Verification required matching contract code. NFT ownership still does not move a conventional Safe owner.";
  }
  if (status === "not_configured") {
    return "No smart-account address is stored for this citizen.";
  }
  return "The record does not claim a deployed wallet.";
}

export function citizenWalletWorldLine(input: {
  persistence: CivilizationTreasuryView["persistence"];
  assignments: WalletAssignment[] | null;
}): string {
  if (input.persistence === "not_persisted") {
    return "Citizen wallets are not stored. No smart account is deployed.";
  }
  if (input.persistence === "migration_pending") {
    return "Citizen wallet records are waiting for the Phase 2 migration. No smart account is deployed.";
  }
  if (input.persistence === "unavailable" || !input.assignments) {
    return "Citizen wallet records could not be read. No deployment is assumed.";
  }
  if (input.assignments.length === 0) {
    return "No citizen wallet assignment is stored yet. None are predicted or deployed.";
  }
  const deployed = input.assignments.filter((row) => row.status === "deployed" || row.status === "verified").length;
  const predicted = input.assignments.filter(
    (row) => row.status === "address_predicted" || row.status === "deployment_pending",
  ).length;
  if (deployed === 0 && predicted === 0) {
    return `${input.assignments.length} citizen wallet records are stored as not configured. No address has been predicted or deployed.`;
  }
  return `${input.assignments.length} citizen wallet records. ${predicted} predicted, ${deployed} with observed code. A prediction is not a deployment.`;
}
