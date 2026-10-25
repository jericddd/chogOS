import { addresses } from "@/lib/blockchain/addresses";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/blockchain/explorer";
import { confirmedPayoutReason, economicPayoutReason } from "@/lib/chogbank/payout-reason";
import { presentOtherTokens, type HeldTokenScan, type PublicOtherToken } from "@/lib/economy/held-tokens";
import { APPLICATION_TREASURY_LIMITS } from "@/lib/economy/treasury-policy";
import { formatTokenAmount } from "@/lib/wallets/present";

export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const ZERO = "0x0000000000000000000000000000000000000000";

export type CallResult = "reverted" | "returned" | "unread";

export type ChainCaps = {
  windowSeconds: number;
  maxAuthorizationTtl: number;
  maxPerTxMon: bigint;
  maxCitizenWindowMon: bigint;
  maxAggregateWindowMon: bigint;
  maxPerTxChog: bigint;
  maxCitizenWindowChog: bigint;
  maxAggregateWindowChog: bigint;
};

export type OwnerlessInspection = {
  appChainId: number;
  configuredAddress: string | null;
  blockedReason: string | null;
  codeBytes: number | null;
  observedChainId: number | null;
  genesis: string | null;
  chogToken: string | null;
  authorizer: string | null;
  implementationSlot: string | null;
  adminSlot: string | null;
  ownerCall: CallResult;
  adminCall: CallResult;
  implementationCall: CallResult;
  upgradeCall: CallResult;
  monRaw: bigint | null;
  chogRaw: bigint | null;
  chogDecimals: number | null;
  chainCaps: ChainCaps | null;
  /** Present only after a receipt check. A bare hash is not a deployment record. */
  deploymentTx: string | null;
  deploymentTxVerified: boolean;
  readError: string | null;
};

export type StoredTreasuryDecision = {
  id: string;
  status: string;
  rationale: string | null;
  createdAt: string | null;
  output: unknown;
  /** Missing means a treasury allocation review. */
  purpose?: string;
};

export type VerifiedDistribution = {
  decisionId: string;
  tokenId: string;
  recipient: string;
  asset: "MON" | "CHOG";
  amountRaw: string;
  txHash: string;
  blockNumber: string;
  /** Present when the Distributed log was decoded. Compared with the stored sentence. */
  reasonHash?: string | null;
};

export type VerifiedFunding = {
  txHash: string;
  blockNumber: string;
  from: string;
  asset: "MON" | "CHOG";
  amountRaw: string;
  kind: "funded_event" | "direct_chog_transfer";
};

export type PublicTreasuryDecision = {
  id: string;
  statusLabel: "Proposed" | "Rejected" | "Authorized" | "Submitted" | "Confirmed" | "Failed" | "Pending";
  headline: string;
  detail: string;
  amountText: string | null;
  citizen: string | null;
  recipient: string | null;
  txHash: string | null;
  txHref: string | null;
  txLabel: string | null;
};

export type FundingScan = "empty" | "complete" | "unreadable";

export type ChogBankPublicView = {
  deploymentState: "pending" | "rejected" | "unreadable" | "live";
  fundingReady: false | true;
  fundingScan: FundingScan | "skipped";
  fundingAddress: string | null;
  explorerContractHref: string | null;
  deploymentTxHref: string | null;
  sourceVerified: false;
  sourceNote: string;
  networkLabel: string;
  ownerStatus: string;
  proxyStatus: string;
  authorizerStatus: string;
  monText: string;
  chogText: string;
  otherTokenStatus: "skipped" | HeldTokenScan["status"];
  otherTokenNote: string;
  otherTokens: PublicOtherToken[];
  execution: string;
  policy: string[];
  reviewThresholds: string[];
  contractLimits: string[];
  funding: string[];
  fundingRows: Array<VerifiedFunding & { amountText: string; href: string | null; label: string }>;
  fundingNote: string;
  decisions: PublicTreasuryDecision[];
  decisionsNote: string;
  warnings: string[];
  summary: string;
};

export function pendingInspection(appChainId: number): OwnerlessInspection {
  return {
    appChainId,
    configuredAddress: null,
    blockedReason: null,
    codeBytes: null,
    observedChainId: null,
    genesis: null,
    chogToken: null,
    authorizer: null,
    implementationSlot: null,
    adminSlot: null,
    ownerCall: "unread",
    adminCall: "unread",
    implementationCall: "unread",
    upgradeCall: "unread",
    monRaw: null,
    chogRaw: null,
    chogDecimals: null,
    chainCaps: null,
    deploymentTx: null,
    deploymentTxVerified: false,
    readError: null,
  };
}

export function knownAddressProblem(address: string): string | null {
  const lower = address.toLowerCase();
  if (lower === ZERO) return "The zero address is not a treasury.";
  if (lower === addresses.chogTreasury.toLowerCase()) return "That address is the ChogTreasury NFT holder, not the economic treasury.";
  if (lower === addresses.chogGenesis.toLowerCase()) return "That address is the Chog Genesis NFT contract.";
  if (lower === addresses.chogToken.toLowerCase()) return "That address is the official $CHOG token.";
  return null;
}

function zeroSlot(value: string | null): boolean {
  if (!value) return false;
  const body = value.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(body) && /^0+$/.test(body);
}

function sameAddress(left: string | null, right: string): boolean {
  return left != null && left.toLowerCase() === right.toLowerCase();
}

function deploymentHref(fundingReady: boolean, inspection: OwnerlessInspection): string | null {
  if (!fundingReady || !inspection.deploymentTxVerified || !inspection.deploymentTx || !HASH.test(inspection.deploymentTx)) {
    return null;
  }
  return explorerTxUrl(143, inspection.deploymentTx);
}

function fundingCopy(fundingReady: boolean, scan: FundingScan | undefined, cause: "no-start" | undefined, hasRows: boolean): string {
  if (!fundingReady) return "No funding transaction is shown because this address is not a verified treasury.";
  if (scan === "empty") {
    return "The scan from the verified deployment block through the latest block finished. No successful Funded or Distributed event was found. The balances above are separate chain-state reads.";
  }
  if (scan === "complete") {
    return "The scan from the verified deployment block through the latest block finished. Each row is a successful receipt in that range. The balances above are separate chain-state reads.";
  }
  if (cause === "no-start") {
    return "The deployment receipt is not verified, so the log scan has no start block. This is not a claim that no Funded or Distributed event exists. No funding transaction was invented.";
  }
  const partial = hasRows ? " Rows below are successful receipts from the blocks that were read." : "";
  return `Funding and payout logs were not read through the latest block. This is not a claim that no Funded or Distributed event exists.${partial} No funding transaction was invented.`;
}

function decisionCopy(loaded: boolean, fundingReady: boolean, scan: FundingScan | undefined): string {
  if (!loaded) return "Treasury decisions were not loaded. An empty list is not a claim that none exist.";
  const base =
    "A proposed allocation is an off-chain review. It is a payment only when a confirmed Distributed event on Monad mainnet is shown with a transaction link. A wallet-issuance row is a decision to create a wallet. It is a deployment only when that row shows a confirmed Monad transaction. The website does not hold the signing key.";
  if (!fundingReady) return base;
  if (scan === "empty") return `${base} The scan from the deployment block through the latest block found no Distributed event.`;
  if (scan !== "complete") {
    return `${base} The Distributed-event scan did not finish. A proposal without a receipt is not proof that no payout exists.`;
  }
  return base;
}

function chogCapPhrase(raw: bigint): string {
  if (raw === 1n) return "1 wei of $CHOG";
  return `${formatTokenAmount(raw.toString(10), 18, "$CHOG")} (${raw.toString(10)} wei)`;
}

/** Plain-language $CHOG ceiling. A zero cap approves nothing. */
export function chogSpendingCapSentence(perTx: bigint, perCitizen: bigint, aggregate: bigint, subject: string): string {
  if (perTx <= 0n || perCitizen <= 0n || aggregate <= 0n) {
    return `${subject} $CHOG cap is 0 wei. No token amount is approved.`;
  }
  if (perTx === perCitizen && perCitizen === aggregate) {
    return `${subject} $CHOG cap is ${chogCapPhrase(perTx)} per transaction, per citizen, and for the whole bank in each window. A larger amount is rejected.`;
  }
  return `${subject} $CHOG cap is ${chogCapPhrase(perTx)} per transaction, ${chogCapPhrase(perCitizen)} per citizen, and ${chogCapPhrase(aggregate)} for the whole bank in each window. A larger amount is rejected.`;
}

function applicationPolicy(): string[] {
  const limits = APPLICATION_TREASURY_LIMITS;
  return [
    "These are application review limits. They are not caps of a deployed contract.",
    `Chain ${limits.chainId}. Window ${limits.windowSeconds} seconds. Authorization lifetime at most ${limits.maxAuthorizationTtl} seconds.`,
    `MON per transaction ${formatTokenAmount(limits.maxPerTxMon.toString(10), 18, "MON")}. Per citizen ${formatTokenAmount(limits.maxCitizenWindowMon.toString(10), 18, "MON")}. Aggregate ${formatTokenAmount(limits.maxAggregateWindowMon.toString(10), 18, "MON")}.`,
    chogSpendingCapSentence(limits.maxPerTxChog, limits.maxCitizenWindowChog, limits.maxAggregateWindowChog, "Review"),
    "$CHOG is not available for a payout while that deployed cap is 1 wei. MON is the usable payout asset.",
    "A model cannot raise these limits. A passing review is not itself a signature. A proposal above a contract cap is rejected. A confirmed payout shows the amount in the Distributed event. When that amount differs from the request, both amounts are shown.",
    "A payout reverts unless that citizen's wallet has code and its stored token id matches. An empty prediction is not paid. The NFT holder does not control the wallet. A wallet-issuance proposal is not a deployment until its Monad transaction is confirmed. The website does not sign or broadcast.",
  ];
}

function chainPolicy(caps: ChainCaps): string[] {
  return [
    "These values were read from the deployed contract. No function in the contract changes them.",
    `Window ${caps.windowSeconds} seconds. Signed authorization lifetime at most ${caps.maxAuthorizationTtl} seconds.`,
    `MON per transaction ${formatTokenAmount(caps.maxPerTxMon.toString(10), 18, "MON")}. Per citizen ${formatTokenAmount(caps.maxCitizenWindowMon.toString(10), 18, "MON")}. Aggregate ${formatTokenAmount(caps.maxAggregateWindowMon.toString(10), 18, "MON")}.`,
    chogSpendingCapSentence(caps.maxPerTxChog, caps.maxCitizenWindowChog, caps.maxAggregateWindowChog, "Contract"),
  ];
}

type Output = {
  stage?: string;
  tokenId?: string;
  asset?: string;
  amountRaw?: string;
  requestedAmountRaw?: string;
  reason?: string;
  reasonHash?: string;
  expectedOutcome?: string;
  decisionId?: string;
  txHash?: string;
  blockNumber?: string;
  chainId?: number;
  onchain?: boolean;
  verified?: boolean;
  recipient?: string;
  choice?: string;
  address?: string;
};

function readOutput(value: unknown): Output {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === "string" ? body[key] : undefined);
  return {
    stage: text("stage"),
    tokenId: text("tokenId") ?? (typeof body.tokenId === "number" ? String(body.tokenId) : undefined),
    asset: text("asset"),
    amountRaw: text("amountRaw"),
    requestedAmountRaw: text("requestedAmountRaw"),
    reason: text("reason"),
    reasonHash: text("reasonHash"),
    expectedOutcome: text("expectedOutcome"),
    decisionId: text("decisionId"),
    txHash: text("txHash"),
    blockNumber: text("blockNumber"),
    chainId: typeof body.chainId === "number" ? body.chainId : undefined,
    onchain: body.onchain === true,
    verified: body.verified === true,
    recipient: text("recipient"),
    choice: text("choice"),
    address: text("address"),
  };
}

function amountText(asset: string | undefined, amountRaw: string | undefined, decimals: number | null): string | null {
  if ((asset !== "MON" && asset !== "CHOG") || !amountRaw || !/^[0-9]+$/.test(amountRaw)) return null;
  if (asset === "MON") return formatTokenAmount(amountRaw, 18, "MON");
  if (decimals !== 18) return `${amountRaw} base units of $CHOG`;
  return formatTokenAmount(amountRaw, 18, "$CHOG");
}

function listedDecision(row: StoredTreasuryDecision): boolean {
  const output = readOutput(row.output);
  if (row.purpose === "wallet_issuance") return output.choice === "issue";
  return true;
}

function allocationAmountText(
  statusLabel: PublicTreasuryDecision["statusLabel"],
  asset: string | undefined,
  amountRaw: string | undefined,
  requestedAmountRaw: string | undefined,
  decimals: number | null,
): string | null {
  const shown = amountText(asset, amountRaw, decimals);
  if (!shown) return null;
  const requested =
    requestedAmountRaw && requestedAmountRaw !== amountRaw ? amountText(asset, requestedAmountRaw, decimals) : null;
  if (statusLabel === "Confirmed") {
    return requested ? `Confirmed ${shown}. The stored request was ${requested}.` : `Confirmed ${shown}`;
  }
  if (statusLabel === "Submitted") return `Submitted ${shown}. This is not a confirmed payout.`;
  if (statusLabel === "Proposed" || statusLabel === "Authorized" || statusLabel === "Pending") {
    return `Proposed ${shown}. This is not a payment.`;
  }
  return `${statusLabel} ${shown}. This is not a payment.`;
}

function issuanceDecision(row: StoredTreasuryDecision): PublicTreasuryDecision {
  const output = readOutput(row.output);
  const choice = output.choice === "issue" || output.choice === "defer" || output.choice === "unnecessary" ? output.choice : "recorded";
  const reason = output.reason || row.rationale || "No reason was stored.";
  const citizen = output.tokenId && /^[0-9]+$/.test(output.tokenId) ? `Citizen token ${output.tokenId}` : null;
  const confirmed =
    output.onchain === true &&
    output.verified === true &&
    output.chainId === 143 &&
    (output.stage === "executed" || row.status === "executed");
  const txHash = output.txHash && HASH.test(output.txHash) ? output.txHash : null;
  let statusLabel: PublicTreasuryDecision["statusLabel"] = "Pending";
  if (output.stage === "failed" || row.status === "failed") statusLabel = "Failed";
  else if (output.stage === "rejected" || row.status === "rejected") statusLabel = "Rejected";
  else if (confirmed) statusLabel = "Confirmed";
  else if (output.stage === "proposed" || row.status === "proposed") statusLabel = "Proposed";
  const linked = confirmed && txHash != null;
  const detail = linked
    ? `${choice}. ${reason} Monad transaction ${txHash} created this wallet.`
    : confirmed && output.address
      ? `${choice}. ${reason} Wallet code is on Monad at ${output.address}. This record did not broadcast a new transaction.`
      : `${choice}. ${reason} This record is not a deployment and not a payment.`;
  return {
    id: row.id,
    statusLabel,
    headline: citizen ? `${statusLabel} wallet issuance for ${citizen}` : `${statusLabel} wallet issuance`,
    detail,
    amountText: null,
    citizen,
    recipient: output.address ?? null,
    txHash: linked ? txHash : null,
    txHref: linked && txHash ? explorerTxUrl(143, txHash) : null,
    txLabel: linked && txHash ? "View wallet transaction" : null,
  };
}

function storedReasonRecord(output: Output): Record<string, unknown> {
  return {
    verified: output.verified === true,
    onchain: output.onchain === true,
    chainId: output.chainId,
    txHash: output.txHash,
    reason: output.reason,
    reasonHash: output.reasonHash,
  };
}

function citizenWallet(output: Output): string | null {
  const address = output.address && /^0x[0-9a-fA-F]{40}$/.test(output.address) ? output.address : null;
  const recipient = output.recipient && /^0x[0-9a-fA-F]{40}$/.test(output.recipient) ? output.recipient : null;
  return address ?? recipient;
}

function reviewDetail(output: Output, rationale: string | null): string {
  const economic = economicPayoutReason(output.reason);
  const decisionId = output.decisionId && HASH.test(output.decisionId) ? output.decisionId : null;
  const id = decisionId ? ` Stored decision id ${decisionId}.` : "";
  const expected = output.expectedOutcome ? ` Expected outcome: ${output.expectedOutcome}` : "";
  const review = rationale?.trim() ?? "";
  const policy =
    review && economicPayoutReason(review) == null && review !== (output.reason ?? "").trim() ? ` Review note: ${review}` : "";
  if (economic) return `${economic}.${id}${expected}${policy} This row is not a confirmed payout.`;
  return `No world-grounded reason is stored.${id}${policy} This row is not a confirmed payout.`;
}

function confirmedDetail(reason: string | null, txHash: string): string {
  if (reason) return `${reason} Monad transaction ${txHash} is the verified Distributed event.`;
  return `The stored world reason could not be verified. Monad transaction ${txHash} is the Distributed event.`;
}

function offchainDecision(row: StoredTreasuryDecision, decimals: number | null): PublicTreasuryDecision {
  const output = readOutput(row.output);
  const citizen = output.tokenId && /^[0-9]+$/.test(output.tokenId) ? `Citizen token ${output.tokenId}` : null;
  const confirmed =
    (output.stage === "confirmed" || row.status === "confirmed" || row.status === "executed") &&
    output.onchain === true &&
    output.verified === true &&
    output.chainId === 143 &&
    !!output.txHash &&
    HASH.test(output.txHash) &&
    !!output.blockNumber &&
    DECIMAL.test(output.blockNumber);
  let statusLabel: PublicTreasuryDecision["statusLabel"] = "Pending";
  if (confirmed) statusLabel = "Confirmed";
  else if (output.stage === "failed" || row.status === "failed") statusLabel = "Failed";
  else if (output.stage === "rejected" || row.status === "rejected") statusLabel = "Rejected";
  else if (output.stage === "authorized") statusLabel = "Authorized";
  else if (output.stage === "submitted" || row.status === "queued") statusLabel = "Submitted";
  else if (output.stage === "proposed" || row.status === "proposed" || row.status === "accepted") statusLabel = "Proposed";
  const storedHash = output.txHash && HASH.test(output.txHash) ? output.txHash : null;
  const noun = statusLabel === "Confirmed" ? "payout" : statusLabel === "Submitted" ? "transaction" : "allocation";
  const reason = confirmed && storedHash
    ? confirmedPayoutReason({
        kind: "treasury.paid",
        chainStatus: "confirmed",
        chainId: output.chainId ?? null,
        txHash: storedHash,
        output: storedReasonRecord(output),
      })
    : null;
  return {
    id: row.id,
    statusLabel,
    headline: citizen ? `${statusLabel} ${noun} for ${citizen}` : `${statusLabel} treasury ${noun}`,
    detail: confirmed && storedHash ? confirmedDetail(reason, storedHash) : reviewDetail(output, row.rationale),
    amountText: allocationAmountText(statusLabel, output.asset, output.amountRaw, output.requestedAmountRaw, decimals),
    citizen,
    recipient: confirmed ? citizenWallet(output) : null,
    txHash: confirmed ? storedHash : null,
    txHref: confirmed ? explorerTxUrl(143, storedHash) : null,
    txLabel: confirmed ? "View payout receipt" : null,
  };
}

function chainDecision(row: VerifiedDistribution, decimals: number | null, db: StoredTreasuryDecision | undefined): PublicTreasuryDecision {
  const output = db ? readOutput(db.output) : {};
  const reason = confirmedPayoutReason({
    kind: "treasury.paid",
    chainStatus: "confirmed",
    chainId: 143,
    txHash: row.txHash,
    output: storedReasonRecord(output),
    reasonHash: row.reasonHash ?? output.reasonHash ?? null,
  });
  return {
    id: row.decisionId,
    statusLabel: "Confirmed",
    headline: `Confirmed payout for citizen token ${row.tokenId}`,
    detail: confirmedDetail(reason, row.txHash),
    amountText: allocationAmountText("Confirmed", row.asset, row.amountRaw, output.requestedAmountRaw, decimals),
    citizen: `Citizen token ${row.tokenId}`,
    recipient: row.recipient,
    txHash: row.txHash,
    txHref: explorerTxUrl(143, row.txHash),
    txLabel: "View payout receipt",
  };
}

export function presentOwnerlessTreasury(input: {
  inspection: OwnerlessInspection;
  decisions: readonly StoredTreasuryDecision[];
  decisionsLoaded: boolean;
  distributions?: readonly VerifiedDistribution[];
  fundingRows?: readonly VerifiedFunding[];
  /** A missing scan is unreadable. It is not an empty history. */
  fundingScan?: FundingScan;
  fundingScanCause?: "no-start";
  /** Missing means other tokens were not read. It does not mean the contract holds none. */
  heldTokens?: HeldTokenScan;
}): ChogBankPublicView {
  const inspection = input.inspection;
  const warnings: string[] = [];
  const reviewThresholds = applicationPolicy();
  const contractLimits: string[] = [];
  const execution =
    "Signing on this server is disabled. This server does not sign or broadcast. A scheduled AI mind run stores proposals and does not pay them. A person starts one stored ChogBank payout by entering that decision id. Verify links the Monad receipt. MON receipts are already recorded. The contract cap on $CHOG remains 1 wei. A recorded MON payout does not increase that cap. $CHOG is not a usable payout.";
  const sourceNote = "Source-code verification: not checked.";
  let deploymentState: ChogBankPublicView["deploymentState"] = "pending";
  let fundingReady = false;
  let summary = "ChogBank is not deployed. There is no funding address and no live balance.";

  if (!inspection.configuredAddress) {
    warnings.push("CHOG_BANK_CONTRACT_ADDRESS is unset. No predicted address is shown in its place.");
  } else if (inspection.appChainId !== 143) {
    deploymentState = "rejected";
    warnings.push(`The app chain is ${inspection.appChainId}. This treasury is valid only on Monad mainnet, chain 143. ${inspection.configuredAddress} is not a funding address.`);
    summary = "The app is not pointed at chain 143, so no funding address is shown.";
  } else if (inspection.blockedReason || knownAddressProblem(inspection.configuredAddress)) {
    deploymentState = "rejected";
    const reason = inspection.blockedReason ?? knownAddressProblem(inspection.configuredAddress);
    warnings.push(`${inspection.configuredAddress} is not a funding address. ${reason}`);
    summary = "The configured address is a known contract that is not ChogBank.";
  } else if (inspection.readError && inspection.codeBytes == null) {
    deploymentState = "unreadable";
    warnings.push(`${inspection.configuredAddress} was not verified. ${inspection.readError} It is not a funding address.`);
    summary = "The configured address could not be verified on Monad mainnet.";
  } else if (inspection.codeBytes === 0) {
    deploymentState = "rejected";
    warnings.push(`${inspection.configuredAddress} has no contract code on Monad mainnet. It is not a funding address.`);
    summary = "The configured address is empty. An empty address is not a treasury.";
  } else if (inspection.codeBytes == null || inspection.codeBytes < 1) {
    deploymentState = "unreadable";
    warnings.push("Contract code was not read. No funding address is shown.");
  } else {
    const problems: string[] = [];
    const unread: string[] = [];
    if (inspection.observedChainId == null) unread.push("configured chain id");
    else if (inspection.observedChainId !== 143) problems.push("The contract's configured chain id is not 143.");
    if (!inspection.genesis) unread.push("Genesis address");
    else if (!sameAddress(inspection.genesis, addresses.chogGenesis)) problems.push("The pinned Genesis address does not match the official collection.");
    if (!inspection.chogToken) unread.push("token address");
    else if (!sameAddress(inspection.chogToken, addresses.chogToken)) problems.push("The pinned token does not match official $CHOG.");
    if (!inspection.authorizer) unread.push("authorizer");
    else if (sameAddress(inspection.authorizer, ZERO) || sameAddress(inspection.authorizer, inspection.configuredAddress)) {
      problems.push("The authorizer is missing or is the contract itself.");
    }
    if (!inspection.implementationSlot || !inspection.adminSlot) unread.push("proxy slots");
    else if (!zeroSlot(inspection.implementationSlot) || !zeroSlot(inspection.adminSlot)) problems.push("An EIP-1967 implementation or admin slot is set.");
    const calls: Array<[string, CallResult]> = [
      ["owner()", inspection.ownerCall],
      ["admin()", inspection.adminCall],
      ["implementation()", inspection.implementationCall],
      ["upgradeTo(address)", inspection.upgradeCall],
    ];
    if (calls.some(([, result]) => result === "unread")) unread.push("privileged-function checks");
    for (const [name, result] of calls) {
      if (result === "returned") problems.push(`${name} returned data on a read-only call.`);
    }
    if (!inspection.chainCaps) unread.push("spending caps");
    if (problems.length > 0) {
      deploymentState = "rejected";
      warnings.push(`${inspection.configuredAddress} failed the owner, proxy, chain, and asset checks. It is not a funding address. ${problems.join(" ")}`);
      summary = "Deployed code was found, and it did not pass the owner, proxy, chain, and asset checks.";
    } else if (unread.length > 0) {
      deploymentState = "unreadable";
      warnings.push(`${inspection.configuredAddress} is not a funding address. These checks did not finish: ${unread.join(", ")}.`);
      summary = "Deployed code was found, and the owner, proxy, chain, and asset checks did not finish.";
    } else if (inspection.chainCaps) {
      deploymentState = "live";
      fundingReady = true;
      summary = "Deployed code on Monad mainnet passed the owner, proxy, chain, and asset checks. A person starts one stored MON payout, and Verify links the receipt.";
      contractLimits.push(...chainPolicy(inspection.chainCaps));
      if (inspection.deploymentTx && !inspection.deploymentTxVerified) {
        warnings.push("A deployment transaction was configured, and it is not linked. The receipt must be a successful creation of this contract.");
      }
    }
  }

  const decimals = inspection.chogDecimals;
  const distributions = fundingReady ? (input.distributions ?? []) : [];
  const seen = new Set(distributions.map((row) => row.decisionId.toLowerCase()));
  const allocationRows = input.decisions.filter((row) => row.purpose !== "wallet_issuance");
  const issuanceRows = input.decisions.filter((row) => row.purpose === "wallet_issuance");
  const decisions: PublicTreasuryDecision[] = [];
  for (const row of distributions) {
    if (!HASH.test(row.txHash) || !HASH.test(row.decisionId) || !DECIMAL.test(row.blockNumber) || !/^[0-9]+$/.test(row.tokenId)) continue;
    const db = allocationRows.find((item) => readOutput(item.output).decisionId?.toLowerCase() === row.decisionId.toLowerCase());
    decisions.push(chainDecision(row, decimals, db));
  }
  if (input.decisionsLoaded) {
    for (const row of allocationRows) {
      if (!listedDecision(row)) continue;
      const decisionId = readOutput(row.output).decisionId;
      if (decisionId && seen.has(decisionId.toLowerCase())) continue;
      decisions.push(offchainDecision(row, decimals));
    }
    for (const row of issuanceRows) {
      if (!listedDecision(row)) continue;
      decisions.push(issuanceDecision(row));
    }
  }

  const fundingRows = fundingReady
    ? (input.fundingRows ?? []).flatMap((row) => {
        if (!HASH.test(row.txHash) || !DECIMAL.test(row.blockNumber)) return [];
        const text = amountText(row.asset, row.amountRaw, decimals);
        if (!text) return [];
        return [
          {
            ...row,
            amountText: text,
            href: explorerTxUrl(143, row.txHash),
            label: row.kind === "direct_chog_transfer" ? "Direct $CHOG transfer" : "ChogBank Funded event",
          },
        ];
      })
    : [];

  const other = fundingReady
    ? presentOtherTokens(input.heldTokens)
    : { status: "skipped" as const, note: "", rows: [] as PublicOtherToken[] };

  return {
    deploymentState,
    fundingReady,
    fundingAddress: fundingReady ? inspection.configuredAddress : null,
    explorerContractHref: fundingReady ? explorerAddressUrl(143, inspection.configuredAddress) : null,
    deploymentTxHref: deploymentHref(fundingReady, inspection),
    sourceVerified: false,
    sourceNote,
    networkLabel: "Monad mainnet · chain id 143",
    ownerStatus: fundingReady
      ? "No owner call returned an address. owner(), admin(), implementation(), and upgradeTo() reverted on read-only calls. This is not a formal audit."
      : "Owner and admin status cannot be claimed until deployed code passes the checks.",
    proxyStatus: fundingReady
      ? "The EIP-1967 implementation and admin slots are zero. No proxy was observed by those slots."
      : "Proxy status is not claimed. A missing contract is not the same as an immutable contract.",
    authorizerStatus: fundingReady
      ? `Spending authorizer ${inspection.authorizer}. This address can sign allocations inside the contract caps and only to a deployed citizen wallet. It cannot change caps, upgrade the contract, or pay an arbitrary address. It is a privileged spending authority.`
      : "No spending authorizer is published because the contract is not an accepted treasury.",
    monText: fundingReady && inspection.monRaw != null ? formatTokenAmount(inspection.monRaw.toString(10), 18, "MON") : "Not read",
    chogText:
      fundingReady && inspection.chogRaw != null && decimals === 18
        ? formatTokenAmount(inspection.chogRaw.toString(10), 18, "$CHOG")
        : "Not read",
    otherTokenStatus: other.status,
    otherTokenNote: other.note,
    otherTokens: other.rows,
    execution,
    reviewThresholds,
    contractLimits,
    policy: [...reviewThresholds, ...contractLimits],
    funding: fundingReady
      ? [
          `Send native MON to ${inspection.configuredAddress}. A token approval is not required.`,
          `Send $CHOG with a normal token transfer to ${inspection.configuredAddress}. The official token uses ${decimals ?? "unread"} decimals.`,
          "A direct $CHOG transfer raises the token balance without a ChogBank event. depositChog emits Funded for the amount the contract actually receives.",
          "Do not send funds to a predicted citizen wallet, a predicted factory, the Genesis NFT contract, or the ChogTreasury NFT holder.",
        ]
      : [
          "No funding address is ready.",
          "Do not send MON or $CHOG to a predicted wallet, a predicted factory, the ChogTreasury NFT holder, the Genesis contract, or the token contract.",
        ],
    fundingRows,
    fundingScan: fundingReady ? (input.fundingScan ?? "unreadable") : "skipped",
    fundingNote: fundingCopy(fundingReady, input.fundingScan, input.fundingScanCause, fundingRows.length > 0),
    decisions,
    decisionsNote: decisionCopy(input.decisionsLoaded, fundingReady, input.fundingScan),
    warnings,
    summary,
  };
}
