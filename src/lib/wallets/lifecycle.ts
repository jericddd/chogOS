import type { Address } from "viem";
import {
  CITIZEN_WALLET_SCHEME,
  walletControlFollowsNftOwner,
  type CitizenWalletScheme,
} from "@/lib/wallets/authority";
import { safeVersionForMasterCopy, type SafeVersion } from "@/lib/wallets/infrastructure";

export const walletStatuses = [
  "not_configured",
  "pending",
  "address_predicted",
  "deployment_pending",
  "deployed",
  "verified",
  "failed",
] as const;

export type WalletStatus = (typeof walletStatuses)[number];

export type WalletAssignment = {
  citizenId: string;
  chainId: 143 | 10143;
  scheme: CitizenWalletScheme;
  status: WalletStatus;
  predictedAddress: string | null;
  accountAddress: string | null;
};

export function planUnassignedWallets(input: {
  citizens: Array<{ id: string; chainId: 143 | 10143 }>;
  existing: WalletAssignment[];
}): { creates: WalletAssignment[]; unchanged: number } {
  const creates: WalletAssignment[] = [];
  let unchanged = 0;
  const seen = new Set<string>();

  for (const citizen of input.citizens) {
    const key = `${citizen.chainId}:${citizen.id}:${CITIZEN_WALLET_SCHEME}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const found = input.existing.find(
      (row) =>
        row.citizenId === citizen.id &&
        row.chainId === citizen.chainId &&
        row.scheme === CITIZEN_WALLET_SCHEME,
    );
    if (found) {
      unchanged += 1;
      continue;
    }
    creates.push({
      citizenId: citizen.id,
      chainId: citizen.chainId,
      scheme: CITIZEN_WALLET_SCHEME,
      status: "not_configured",
      predictedAddress: null,
      accountAddress: null,
    });
  }

  return { creates, unchanged };
}

export function statusAfterEvidence(input: {
  nftOwnershipVerified: boolean;
  evidence: "none" | "predicted" | "deployment_submitted" | "code_present" | "code_matched";
}): WalletStatus {
  if (input.evidence === "code_matched" && !input.nftOwnershipVerified) {
    return "failed";
  }
  switch (input.evidence) {
    case "none":
      return "not_configured";
    case "predicted":
      return "address_predicted";
    case "deployment_submitted":
      return "deployment_pending";
    case "code_present":
      return "deployed";
    case "code_matched":
      return "verified";
  }
}

export function assessClientWalletClaim(body: { status?: string } | null): { accepted: false; reason: string } {
  const status = body?.status;
  if (status === "verified" || status === "deployed" || status === "address_predicted") {
    return {
      accepted: false,
      reason: "A browser claim cannot mark a wallet predicted, deployed, or verified. Chain code is the evidence.",
    };
  }
  return {
    accepted: false,
    reason: "Wallet status is assigned by the server. A database edit from the browser is not verification.",
  };
}

export function walletStatusCopy(status: WalletStatus | null): string {
  switch (status) {
    case "not_configured":
      return "No wallet is assigned. An address has not been predicted or deployed.";
    case "pending":
      return "Wallet setup is pending. No account address is accepted yet.";
    case "address_predicted":
      return "An address was predicted. Prediction is not deployment and not verification.";
    case "deployment_pending":
      return "A deployment transaction was submitted. The account is not verified.";
    case "deployed":
      return "Contract code was observed. The wallet is not fully verified.";
    case "verified":
      return "Contract code matched the expected wallet implementation.";
    case "failed":
      return "The last wallet check failed. The previous assignment was left in place.";
    default:
      return "No wallet record is stored for this citizen.";
  }
}

export function describeNftWalletAuthority(): string {
  if (walletControlFollowsNftOwner()) {
    return "The citizen wallet reads ownerOf, so a transfer moves control.";
  }
  return "NFT ownership authorizes the citizen record. It does not automatically control a smart wallet. No account implementation that checks ownerOf is enabled, so a previous owner cannot spend through a wallet that was never deployed.";
}

export type TreasuryVerification = "unread" | "observed" | "safe_proxy";

export function assessTreasuryCode(input: {
  codeEmpty: boolean;
  masterCopy: Address | null;
}): {
  accountType: "unknown" | "eoa" | "contract";
  verification: TreasuryVerification;
  safeVersion: SafeVersion | null;
  detail: string;
} {
  if (input.codeEmpty) {
    return {
      accountType: "unknown",
      verification: "observed",
      safeVersion: null,
      detail:
        "No contract code was found at this address on the configured chain. It is not labeled an externally owned account or a Safe, and chogOS did not deploy it.",
    };
  }
  const safeVersion = input.masterCopy ? safeVersionForMasterCopy(input.masterCopy) : null;
  if (safeVersion) {
    return {
      accountType: "contract",
      verification: "safe_proxy",
      safeVersion,
      detail: `Safe proxy observed. masterCopy matches ${safeVersion}. chogOS did not deploy this wallet, and the AI has no permission to spend from it.`,
    };
  }
  return {
    accountType: "contract",
    verification: "observed",
    safeVersion: null,
    detail:
      "Contract code is present, but masterCopy did not match a hash-checked Safe singleton. It is not labeled a verified Safe.",
  };
}
