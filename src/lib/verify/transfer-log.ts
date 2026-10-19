import { createPublicClient, getAddress, http, type Hex, type TransactionReceipt } from "viem";
import { getChain } from "@/lib/blockchain/chains";
import { addresses } from "@/lib/blockchain/addresses";
import { publicRpcError } from "@/lib/verify/anchor";
import { ERC721_TRANSFER_TOPIC } from "@/lib/watcher/source";
import { TRANSFER_LOG_UNREAD, presentedAsMainnetGenesis, type TransferEvidence } from "@/lib/world/transfer";

export type TransferLogCheck = {
  attempted: boolean;
  matched: boolean;
  summary: string;
};

export { TRANSFER_LOG_UNREAD };

const TIMEOUT_MS = 4_000;
const GENESIS = addresses.chogGenesis.toLowerCase();

export function unreadTransferLog(): TransferLogCheck {
  return { attempted: false, matched: false, summary: TRANSFER_LOG_UNREAD };
}

function failed(summary: string): TransferLogCheck {
  return { attempted: true, matched: false, summary };
}

function matched(): TransferLogCheck {
  return {
    attempted: true,
    matched: true,
    summary: "A read-only receipt check matched the stored Chog Genesis transfer log.",
  };
}

function withDeadline(promise: Promise<TransferLogCheck>): Promise<TransferLogCheck> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(failed("The read-only RPC did not respond in time.")), TIMEOUT_MS + 1_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(failed("The read-only RPC did not respond in time."));
      },
    );
  });
}

function topicAddress(topic: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    return null;
  }
  try {
    return getAddress(`0x${topic.slice(-40)}`).toLowerCase();
  } catch {
    return null;
  }
}

function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

/**
 * Compare one receipt with the stored watcher fields.
 * A missing receipt, RPC error, reverted receipt, or any mismatch is not a match.
 */
export function assessTransferReceipt(
  evidence: TransferEvidence,
  observedChainId: number | null,
  receipt: Pick<TransactionReceipt, "status" | "blockNumber" | "blockHash" | "logs"> | null,
  rpcError: string | null,
): TransferLogCheck {
  if (!presentedAsMainnetGenesis(evidence)) {
    return unreadTransferLog();
  }
  if (rpcError) {
    return failed(rpcError);
  }
  if (observedChainId !== 143) {
    return failed("The read-only RPC did not report Monad mainnet (143).");
  }
  if (!receipt) {
    return failed("The transaction receipt was not found.");
  }
  if (receipt.status !== "success") {
    return failed("The transaction receipt reverted.");
  }
  if (receipt.blockNumber.toString(10) !== evidence.blockNumber || !same(receipt.blockHash, evidence.blockHash)) {
    return failed("The receipt block does not match the stored block.");
  }
  const wantedIndex = Number(evidence.logIndex);
  const log = receipt.logs.find((item) => item.logIndex === wantedIndex);
  if (!log || log.removed) {
    return failed("No transfer log at the stored log index matched the stored Chog Genesis transfer.");
  }
  const from = log.topics[1] ? topicAddress(log.topics[1]) : null;
  const to = log.topics[2] ? topicAddress(log.topics[2]) : null;
  let tokenId: string | null = null;
  try {
    tokenId = log.topics[3] && /^0x[0-9a-fA-F]{64}$/.test(log.topics[3]) ? BigInt(log.topics[3]).toString(10) : null;
  } catch {
    tokenId = null;
  }
  const aligned =
    same(log.address, GENESIS) &&
    same(log.address, evidence.contract) &&
    same(log.transactionHash, evidence.txHash) &&
    same(log.blockHash, evidence.blockHash) &&
    log.blockNumber.toString(10) === evidence.blockNumber &&
    log.topics[0]?.toLowerCase() === ERC721_TRANSFER_TOPIC &&
    same(from, evidence.from) &&
    same(to, evidence.to) &&
    tokenId === evidence.tokenId;
  if (!aligned) {
    return failed("No transfer log at the stored log index matched the stored Chog Genesis transfer.");
  }
  return matched();
}

/**
 * Read-only receipt comparison. This does not sign, broadcast, or update the watcher.
 * Errors and timeouts fail closed and do not count as a match.
 */
export async function readTransferLog(input: { rpcUrl: string; evidence: TransferEvidence }): Promise<TransferLogCheck> {
  if (!presentedAsMainnetGenesis(input.evidence)) {
    return unreadTransferLog();
  }
  return withDeadline(readTransferLogInner(input));
}

async function readTransferLogInner(input: { rpcUrl: string; evidence: TransferEvidence }): Promise<TransferLogCheck> {
  try {
    const client = createPublicClient({
      chain: getChain(143),
      transport: http(input.rpcUrl, { timeout: TIMEOUT_MS, retryCount: 0 }),
    });
    let observedChainId: number;
    try {
      observedChainId = await client.getChainId();
    } catch (error) {
      return failed(publicRpcError(error, "The read-only chain id read failed."));
    }
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await client.getTransactionReceipt({ hash: input.evidence.txHash as Hex });
    } catch (error) {
      const message = publicRpcError(error, "The transaction receipt could not be read.");
      if (/not found|could not be found/i.test(message)) {
        return assessTransferReceipt(input.evidence, observedChainId, null, null);
      }
      return failed(message);
    }
    return assessTransferReceipt(input.evidence, observedChainId, receipt, null);
  } catch (error) {
    return failed(publicRpcError(error, "The read-only RPC request failed."));
  }
}
