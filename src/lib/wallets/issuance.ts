import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import type { WalletStatus } from "@/lib/wallets/lifecycle";

/**
 * Lifecycle of one citizen's wallet. A citizen in `citizen_active` is a full
 * citizen and has no wallet. These names are the public meanings of the
 * existing registry statuses. This module does not write a registry row.
 */
export const walletLifecycles = [
  "citizen_active",
  "wallet_issuance_proposed",
  "wallet_assigned",
  "wallet_deployed",
  "wallet_ready",
  "wallet_blocked",
] as const;

export type WalletLifecycle = (typeof walletLifecycles)[number];

export type IssuanceChoice = "issue" | "defer" | "unnecessary";

export type IssuanceVerdict = {
  status: "proposed" | "rejected";
  choice: IssuanceChoice | null;
  tokenId: string | null;
  decisionId: Hex | null;
  lifecycle: WalletLifecycle;
  reason: string;
  executed: false;
  onchain: false;
  duplicate: boolean;
};

const ASSIGNED = new Set<WalletLifecycle>(["wallet_assigned", "wallet_deployed", "wallet_ready"]);
const ADMITTED = new Set(["proposed", "accepted", "queued", "executed"]);

/** Same encoding as DeployCitizenWallets: abi.encode(label, chainId, genesis, tokenId). */
export const ISSUANCE_DECISION_LABEL = "chogos.wallet.issue.v3";

export function lifecycleFromWalletStatus(status: WalletStatus | null): WalletLifecycle {
  switch (status) {
    case "pending":
      return "wallet_issuance_proposed";
    case "address_predicted":
    case "deployment_pending":
      return "wallet_assigned";
    case "deployed":
      return "wallet_deployed";
    case "verified":
      return "wallet_ready";
    case "failed":
      return "wallet_blocked";
    case "not_configured":
    case null:
      return "citizen_active";
  }
}

export function issuanceDecisionId(tokenId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [ISSUANCE_DECISION_LABEL, 143n, addresses.chogGenesis, BigInt(tokenId)],
    ),
  );
}

export function isAdmittedIssuanceStatus(status: string): boolean {
  return ADMITTED.has(status);
}

export function evaluateIssuanceDecision(input: {
  choice: IssuanceChoice;
  tokenId: string | null;
  rationale: string;
  eligibleTokenIds: ReadonlySet<string>;
  lifecycleByToken: ReadonlyMap<string, WalletLifecycle>;
  admittedDecisionIds: ReadonlySet<string>;
  deploymentPathReady: boolean;
}): IssuanceVerdict {
  const rationale = input.rationale.trim().slice(0, 320);
  if (!rationale || /https?:\/\//i.test(rationale)) {
    return reject(null, null, "citizen_active", "The rationale must be present and must not contain a URL.");
  }
  if (input.choice === "unnecessary") {
    return unnecessary(input, rationale);
  }
  const tokenId = input.tokenId;
  if (!tokenId || !/^[0-9]+$/.test(tokenId) || !input.eligibleTokenIds.has(tokenId)) {
    return reject(input.choice, null, "citizen_active", "The token id is not an enrolled citizen.");
  }
  const current = input.lifecycleByToken.get(tokenId) ?? "citizen_active";
  if (current === "wallet_blocked") {
    return reject(input.choice, tokenId, current, "Wallet operations are blocked. The existing record was not replaced.");
  }
  if (ASSIGNED.has(current)) {
    return reject(
      input.choice,
      tokenId,
      current,
      "This citizen already has a wallet assignment. It was not replaced and was not given to another token id.",
    );
  }
  if (input.choice === "defer") {
    const existing = issuanceDecisionId(tokenId);
    if (input.admittedDecisionIds.has(existing.toLowerCase())) {
      return reject(
        "defer",
        tokenId,
        "wallet_issuance_proposed",
        "An issuance proposal is already recorded. The deferral did not remove it and did not create a second wallet.",
        existing,
        true,
      );
    }
    return {
      status: "proposed",
      choice: "defer",
      tokenId,
      decisionId: null,
      lifecycle: current,
      reason: `${rationale} Issuance is deferred. No address was assigned.`,
      executed: false,
      onchain: false,
      duplicate: false,
    };
  }
  const decisionId = issuanceDecisionId(tokenId);
  if (input.admittedDecisionIds.has(decisionId.toLowerCase())) {
    return reject(
      "issue",
      tokenId,
      current === "citizen_active" ? "wallet_issuance_proposed" : current,
      "An issuance decision for this citizen is already recorded. It was not deployed again.",
      decisionId,
      true,
    );
  }
  const path = input.deploymentPathReady
    ? "The deployment path is marked ready. This decision still does not sign or create the wallet."
    : "The factory is not deployed from this server, so no address was assigned.";
  return {
    status: "proposed",
    choice: "issue",
    tokenId,
    decisionId,
    lifecycle: "wallet_issuance_proposed",
    reason: `${rationale} ${path}`,
    executed: false,
    onchain: false,
    duplicate: false,
  };
}

function unnecessary(
  input: {
    tokenId: string | null;
    eligibleTokenIds: ReadonlySet<string>;
    lifecycleByToken: ReadonlyMap<string, WalletLifecycle>;
  },
  rationale: string,
): IssuanceVerdict {
  const tokenId = input.tokenId;
  if (tokenId && (!/^[0-9]+$/.test(tokenId) || !input.eligibleTokenIds.has(tokenId))) {
    return reject("unnecessary", null, "citizen_active", "The token id is not an enrolled citizen.");
  }
  const current = tokenId ? (input.lifecycleByToken.get(tokenId) ?? "citizen_active") : "citizen_active";
  if (tokenId && (ASSIGNED.has(current) || current === "wallet_blocked")) {
    return {
      status: "proposed",
      choice: "unnecessary",
      tokenId,
      decisionId: null,
      lifecycle: current,
      reason: `${rationale} The existing wallet record was left unchanged.`,
      executed: false,
      onchain: false,
      duplicate: false,
    };
  }
  return {
    status: "proposed",
    choice: "unnecessary",
    tokenId,
    decisionId: null,
    lifecycle: current,
    reason: `${rationale} No wallet was assigned.`,
    executed: false,
    onchain: false,
    duplicate: false,
  };
}

function reject(
  choice: IssuanceChoice | null,
  tokenId: string | null,
  lifecycle: WalletLifecycle,
  reason: string,
  decisionId: Hex | null = null,
  duplicate = false,
): IssuanceVerdict {
  return {
    status: "rejected",
    choice,
    tokenId,
    decisionId,
    lifecycle,
    reason,
    executed: false,
    onchain: false,
    duplicate,
  };
}
