import { getAddress, type Address, type Hex } from "viem";
import type { BlockHeader, LogSource, RawTransfer } from "@/lib/watcher/types";

/** ERC-721 Transfer(address,address,uint256), all three arguments indexed. */
export const ERC721_TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type ChainLog = {
  address: Address;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  transactionIndex: number | null;
  logIndex: number | null;
  topics: readonly Hex[];
  removed?: boolean;
};

export type ChainReader = {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber?: bigint; blockTag?: "latest" }): Promise<{
    number: bigint;
    hash: Hex | null;
    parentHash: Hex;
  }>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
};

/**
 * Read-only log source. A chain id other than 143 returns an error and does not read logs.
 * This does not sign or broadcast.
 */
export function createTransferSource(reader: ChainReader, nftContract: Address): LogSource {
  const nft = getAddress(nftContract);
  let chainId: number | null = null;

  async function requireChain(): Promise<string | null> {
    if (chainId === null) {
      chainId = await reader.getChainId();
    }
    return chainId === 143 ? null : `wrong chain ${chainId}`;
  }

  return {
    async latest() {
      try {
        const problem = await requireChain();
        if (problem) {
          return { error: problem };
        }
        return toHeader(await reader.getBlock({ blockTag: "latest" }));
      } catch (error) {
        return { error: message(error) };
      }
    },
    async header(blockNumber) {
      try {
        const problem = await requireChain();
        if (problem) {
          return { error: problem };
        }
        const block = await reader.getBlock({ blockNumber });
        if (block.number !== blockNumber) {
          return { error: "block number mismatch" };
        }
        return toHeader(block);
      } catch (error) {
        return { error: message(error) };
      }
    },
    async transfers(fromBlock, toBlock) {
      try {
        const problem = await requireChain();
        if (problem) {
          return { error: problem };
        }
        const logs = await reader.getLogs({ address: nft, fromBlock, toBlock });
        const decoded: RawTransfer[] = [];
        for (const log of logs) {
          const row = decodeTransfer(log, nft);
          if (row) {
            decoded.push(row);
          }
        }
        return decoded;
      } catch (error) {
        return { error: message(error) };
      }
    },
  };
}

export function decodeTransfer(log: ChainLog, nftContract: Address): RawTransfer | null {
  const topic = log.topics[0];
  if (!topic || topic.toLowerCase() !== ERC721_TRANSFER_TOPIC) {
    return null;
  }
  if (
    log.topics.length < 4 ||
    log.blockNumber === null ||
    !log.blockHash ||
    !log.transactionHash ||
    log.transactionIndex === null ||
    log.logIndex === null
  ) {
    return null;
  }
  if (getAddress(log.address) !== getAddress(nftContract)) {
    return null;
  }
  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: getAddress(log.address),
    from: topicAddress(log.topics[1]!),
    to: topicAddress(log.topics[2]!),
    tokenId: BigInt(log.topics[3]!),
    removed: log.removed === true,
  };
}

function toHeader(block: { number: bigint; hash: Hex | null; parentHash: Hex }): BlockHeader | { error: string } {
  if (!block.hash) {
    return { error: "block hash is missing" };
  }
  return { number: block.number, hash: block.hash, parentHash: block.parentHash };
}

function topicAddress(topic: Hex): Address {
  return getAddress(`0x${topic.slice(-40)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "chain read failed";
}
