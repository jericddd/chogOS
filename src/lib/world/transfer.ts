import { addresses } from "@/lib/blockchain/addresses";
import { explorerAddressUrl, explorerBlockUrl, explorerNftUrl, explorerTxUrl } from "@/lib/blockchain/explorer";

export type TransferLinks = {
  transaction: string | null;
  block: string | null;
  contract: string | null;
  from: string | null;
  to: string | null;
  token: string | null;
};

export type CanonicalState = "canonical" | "reorg" | "unset";

/** Fields copied from a watcher log into a civilization event. Absent fields stay null. */
export type TransferEvidence = {
  kind: "nft.transferred";
  /**
   * True only when this row may be presented as a Chog Genesis mainnet transfer.
   * `chain_status = confirmed` is not enough.
   */
  canonical: boolean;
  consistent: boolean;
  /** Watcher snapshot bit. A reorg is `reorg` even when chain_status stays confirmed. */
  canonicalState: CanonicalState;
  chainStatus: string | null;
  issues: string[];
  chainId: number | null;
  /** Row transaction hash. Links are withheld unless `canonical` is true. */
  txHash: string | null;
  /** Payload copy of the hash, when the watcher stored one. Used to detect a mismatch. */
  payloadTxHash: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  txIndex: string | null;
  logIndex: string | null;
  contract: string | null;
  tokenId: string | null;
  from: string | null;
  to: string | null;
  links: TransferLinks;
};

const EMPTY_LINKS: TransferLinks = {
  transaction: null,
  block: null,
  contract: null,
  from: null,
  to: null,
  token: null,
};

const MAINNET_CHAIN_ID = 143;
const GENESIS = addresses.chogGenesis.toLowerCase();
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

export const TRANSFER_LOG_UNREAD =
  "The application did not read this transaction. Compare the explorer transaction and transfer log with the stored fields.";

export const TRANSFER_ISSUE = {
  reorg: "The watcher marked this log as removed from the canonical chain.",
  canonicalMissing: "The watcher canonical bit is missing. A confirmed chain status is not enough.",
  notConfirmed: "chain_status is not confirmed. Confirmed status is necessary and not sufficient.",
  wrongChain: "Chain id is not Monad mainnet (143).",
  hashMismatch: "The payload transaction hash does not match the stored transaction hash.",
  txHash: "The transaction hash is missing or malformed.",
  contractMissing: "The NFT contract address is missing or malformed.",
  wrongContract: "The NFT contract is not the Chog Genesis contract.",
  from: "The sender address is missing or malformed.",
  to: "The receiver address is missing or malformed.",
  token: "The token id is missing or malformed.",
  blockNumber: "The block number is missing or malformed.",
  blockHash: "The block hash is missing or malformed.",
  logIndex: "The log index is missing or malformed.",
  links: "Explorer links could not be built for these identifiers.",
} as const;

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  return null;
}

function chainIdOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && DECIMAL.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) {
      return parsed;
    }
  }
  return null;
}

function decimal(value: string | null, maxLength: number): boolean {
  if (!value || !DECIMAL.test(value) || value.length > maxLength) {
    return false;
  }
  return value === "0" || !value.startsWith("0");
}

export function payloadHashConsistent(txHash: string | null, payloadTxHash: string | null): boolean {
  if (!payloadTxHash) {
    return true;
  }
  if (!txHash) {
    return false;
  }
  return payloadTxHash.toLowerCase() === txHash.toLowerCase();
}

export function transferPresentationIssues(evidence: {
  canonicalState: CanonicalState;
  chainStatus: string | null;
  chainId: number | null;
  txHash: string | null;
  payloadTxHash: string | null;
  contract: string | null;
  from: string | null;
  to: string | null;
  tokenId: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  logIndex: string | null;
}): string[] {
  const issues: string[] = [];
  if (evidence.canonicalState === "reorg") {
    issues.push(TRANSFER_ISSUE.reorg);
  } else if (evidence.canonicalState !== "canonical") {
    issues.push(TRANSFER_ISSUE.canonicalMissing);
  }
  if (evidence.chainStatus !== "confirmed") {
    issues.push(TRANSFER_ISSUE.notConfirmed);
  }
  if (evidence.chainId !== MAINNET_CHAIN_ID) {
    issues.push(TRANSFER_ISSUE.wrongChain);
  }
  if (!payloadHashConsistent(evidence.txHash, evidence.payloadTxHash)) {
    issues.push(TRANSFER_ISSUE.hashMismatch);
  }
  if (!evidence.txHash || !TX_HASH.test(evidence.txHash)) {
    issues.push(TRANSFER_ISSUE.txHash);
  }
  if (!evidence.contract || !ADDRESS.test(evidence.contract)) {
    issues.push(TRANSFER_ISSUE.contractMissing);
  } else if (evidence.contract.toLowerCase() !== GENESIS) {
    issues.push(TRANSFER_ISSUE.wrongContract);
  }
  if (!evidence.from || !ADDRESS.test(evidence.from)) {
    issues.push(TRANSFER_ISSUE.from);
  }
  if (!evidence.to || !ADDRESS.test(evidence.to)) {
    issues.push(TRANSFER_ISSUE.to);
  }
  if (!decimal(evidence.tokenId, 78)) {
    issues.push(TRANSFER_ISSUE.token);
  }
  if (!decimal(evidence.blockNumber, 20)) {
    issues.push(TRANSFER_ISSUE.blockNumber);
  }
  if (!evidence.blockHash || !TX_HASH.test(evidence.blockHash)) {
    issues.push(TRANSFER_ISSUE.blockHash);
  }
  if (!decimal(evidence.logIndex, 10)) {
    issues.push(TRANSFER_ISSUE.logIndex);
  }
  return issues;
}

/** Recomputes the gate from stored fields. A `canonical: true` flag is not trusted by itself. */
export function presentedAsMainnetGenesis(evidence: TransferEvidence): boolean {
  return transferPresentationIssues(evidence).length === 0;
}

export function transferEvidenceFromRow(row: {
  kind: string;
  chain_status?: string | null;
  chain_id?: number | string | null;
  tx_hash?: string | null;
  canonical?: boolean | null;
  payload?: unknown;
}): TransferEvidence | null {
  if (row.kind !== "nft.transferred") {
    return null;
  }
  const payload = payloadRecord(row.payload);
  const chainId = chainIdOf(row.chain_id);
  const txHash = text(row.tx_hash);
  const payloadTx = text(payload.txHash);
  const consistent = payloadHashConsistent(txHash, payloadTx);
  const canonicalState: CanonicalState = row.canonical === true ? "canonical" : row.canonical === false ? "reorg" : "unset";
  const blockNumber = text(payload.blockNumber);
  const blockHash = text(payload.blockHash);
  const txIndex = text(payload.txIndex) ?? text(payload.transactionIndex);
  const logIndex = text(payload.logIndex);
  const contract = text(payload.contract);
  const tokenId = text(payload.tokenId);
  const from = text(payload.from);
  const to = text(payload.to);
  const chainStatus = typeof row.chain_status === "string" ? row.chain_status : null;
  const fields = {
    canonicalState,
    chainStatus,
    chainId,
    txHash,
    payloadTxHash: payloadTx,
    contract,
    from,
    to,
    tokenId,
    blockNumber,
    blockHash,
    logIndex,
  };
  const issues = transferPresentationIssues(fields);
  const links =
    issues.length === 0 && chainId != null
      ? {
          transaction: explorerTxUrl(chainId, txHash),
          block: explorerBlockUrl(chainId, blockNumber),
          contract: explorerAddressUrl(chainId, contract),
          from: explorerAddressUrl(chainId, from),
          to: explorerAddressUrl(chainId, to),
          token: explorerNftUrl(chainId, contract, tokenId),
        }
      : EMPTY_LINKS;
  if (
    issues.length === 0 &&
    (!links.transaction || !links.block || !links.contract || !links.from || !links.to || !links.token)
  ) {
    issues.push(TRANSFER_ISSUE.links);
  }
  return {
    kind: "nft.transferred",
    canonical: issues.length === 0,
    consistent,
    canonicalState,
    chainStatus,
    issues,
    chainId,
    txHash,
    payloadTxHash: payloadTx,
    blockNumber,
    blockHash,
    txIndex,
    logIndex,
    contract,
    tokenId,
    from,
    to,
    links: issues.length === 0 ? links : EMPTY_LINKS,
  };
}
