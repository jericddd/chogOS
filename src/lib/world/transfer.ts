import {
  explorerAddressUrl,
  explorerBlockUrl,
  explorerNftUrl,
  explorerTxUrl,
  isChainSupported,
} from "@/lib/blockchain/explorer";

export type TransferLinks = {
  transaction: string | null;
  block: string | null;
  contract: string | null;
  from: string | null;
  to: string | null;
  token: string | null;
};

/** Fields copied from a watcher log into a civilization event. Absent fields stay null. */
export type TransferEvidence = {
  kind: "nft.transferred";
  canonical: boolean;
  consistent: boolean;
  chainId: number | null;
  /** Row transaction hash. Links are still withheld unless `canonical` is true. */
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

export function transferEvidenceFromRow(row: {
  kind: string;
  chain_status?: string | null;
  chain_id?: number | null;
  tx_hash?: string | null;
  canonical?: boolean | null;
  payload?: unknown;
}): TransferEvidence | null {
  if (row.kind !== "nft.transferred") {
    return null;
  }
  const payload = payloadRecord(row.payload);
  const chainId = typeof row.chain_id === "number" ? row.chain_id : null;
  const txHash = text(row.tx_hash);
  const payloadTx = text(payload.txHash);
  const consistent = !payloadTx || !txHash || payloadTx.toLowerCase() === txHash.toLowerCase();
  const canonical = row.canonical !== false && row.chain_status === "confirmed" && consistent;
  const blockNumber = text(payload.blockNumber);
  const blockHash = text(payload.blockHash);
  const txIndex = text(payload.txIndex) ?? text(payload.transactionIndex);
  const logIndex = text(payload.logIndex);
  const contract = text(payload.contract);
  const tokenId = text(payload.tokenId);
  const from = text(payload.from);
  const to = text(payload.to);
  const linkable = canonical && chainId != null && isChainSupported(chainId);
  return {
    kind: "nft.transferred",
    canonical,
    consistent,
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
    links: linkable
      ? {
          transaction: explorerTxUrl(chainId, txHash),
          block: explorerBlockUrl(chainId, blockNumber),
          contract: explorerAddressUrl(chainId, contract),
          from: explorerAddressUrl(chainId, from),
          to: explorerAddressUrl(chainId, to),
          token: explorerNftUrl(chainId, contract, tokenId),
        }
      : EMPTY_LINKS,
  };
}
