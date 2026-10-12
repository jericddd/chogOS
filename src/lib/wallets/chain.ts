import "server-only";
import { getAddress, keccak256, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { chogTokenObservedAbi } from "@/lib/blockchain/abi/chog-token-observed";
import { CHOG_TOKEN_PROXY_BYTECODE } from "@/lib/blockchain/addresses";
import { createChainClient } from "@/lib/blockchain/public-client";
import type { SupportedChainId } from "@/lib/blockchain/chains";
import type { FundingLeg, TransferLog } from "@/lib/wallets/funding";
import { judgeFunding, rpcChainProblem } from "@/lib/wallets/funding";

const masterCopyAbi = [
  {
    type: "function",
    name: "masterCopy",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

async function requireConfiguredChain(client: PublicClient, chainId: SupportedChainId): Promise<string | null> {
  try {
    return rpcChainProblem(await client.getChainId(), chainId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The RPC chain id could not be read.";
    return message.slice(0, 240);
  }
}

export async function readCode(chainId: SupportedChainId, address: Address, rpcUrl?: string): Promise<
  { empty: true; hash: null; error: null } | { empty: false; hash: Hex; error: null } | { empty: false; hash: null; error: string }
> {
  try {
    const client = createChainClient(chainId, rpcUrl);
    const mismatch = await requireConfiguredChain(client, chainId);
    if (mismatch) {
      return { empty: false, hash: null, error: mismatch };
    }
    const code = await client.getCode({ address });
    if (!code || code === "0x") {
      return { empty: true, hash: null, error: null };
    }
    return { empty: false, hash: keccak256(code), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Code could not be read.";
    return { empty: false, hash: null, error: message.slice(0, 240) };
  }
}

export async function readMasterCopy(
  chainId: SupportedChainId,
  address: Address,
  rpcUrl?: string,
): Promise<{ address: Address | null; error: string | null }> {
  try {
    const client = createChainClient(chainId, rpcUrl);
    const mismatch = await requireConfiguredChain(client, chainId);
    if (mismatch) {
      return { address: null, error: mismatch };
    }
    const value = await client.readContract({
      address,
      abi: masterCopyAbi,
      functionName: "masterCopy",
    });
    return { address: getAddress(value), error: null };
  } catch {
    return { address: null, error: null };
  }
}

export async function readBalances(input: {
  chainId: SupportedChainId;
  treasury: Address;
  chogToken: Address;
  rpcUrl?: string;
}): Promise<
  | { ok: false; detail: string }
  | {
      ok: true;
      blockNumber: string;
      observedAt: string;
      native: { amountRaw: string } | null;
      chog: { amountRaw: string; decimals: number } | { unavailable: string } | null;
    }
> {
  const client = createChainClient(input.chainId, input.rpcUrl);
  try {
    const mismatch = await requireConfiguredChain(client, input.chainId);
    if (mismatch) {
      return { ok: false, detail: mismatch };
    }
    const block = await client.getBlock({ blockTag: "latest" });
    const native = await client.getBalance({ address: input.treasury, blockNumber: block.number });
    let chog: { amountRaw: string; decimals: number } | { unavailable: string } | null = null;
    const tokenCode = await client.getCode({ address: input.chogToken });
    if (!tokenCode || tokenCode.toLowerCase() !== CHOG_TOKEN_PROXY_BYTECODE.toLowerCase()) {
      chog = { unavailable: "The $CHOG contract code did not match the observed proxy. No token balance is shown." };
    } else {
      const [raw, decimals] = await Promise.all([
        client.readContract({
          address: input.chogToken,
          abi: chogTokenObservedAbi,
          functionName: "balanceOf",
          args: [input.treasury],
        }),
        client.readContract({
          address: input.chogToken,
          abi: chogTokenObservedAbi,
          functionName: "decimals",
        }),
      ]);
      chog = { amountRaw: raw.toString(), decimals: Number(decimals) };
    }
    return {
      ok: true,
      blockNumber: block.number.toString(),
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      native: { amountRaw: native.toString() },
      chog,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Balance could not be read.";
    return { ok: false, detail: message.slice(0, 240) };
  }
}

export async function readFunding(input: {
  chainId: SupportedChainId;
  txHash: Hash;
  treasury: Address;
  chogToken: Address;
  rpcUrl?: string;
}): Promise<FundingLeg[]> {
  const client = createChainClient(input.chainId, input.rpcUrl);
  const mismatch = await requireConfiguredChain(client, input.chainId);
  if (mismatch) {
    return judgeFunding({
      treasury: input.treasury,
      chogToken: input.chogToken,
      chogDecimals: null,
      receipt: null,
      transaction: null,
    }).map((leg) => ({ ...leg, detail: mismatch }));
  }
  let chogDecimals: number | null = null;
  try {
    const decimals = await client.readContract({
      address: input.chogToken,
      abi: chogTokenObservedAbi,
      functionName: "decimals",
    });
    chogDecimals = Number(decimals);
  } catch {
    chogDecimals = null;
  }

  try {
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: input.txHash }),
      client.getTransaction({ hash: input.txHash }),
    ]);
    return judgeFunding({
      treasury: input.treasury,
      chogToken: input.chogToken,
      chogDecimals,
      receipt: {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as Hex[],
          data: log.data,
        })) satisfies TransferLog[],
      },
      transaction: {
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not found|could not be found|TransactionReceiptNotFound/i.test(message)) {
      return judgeFunding({
        treasury: input.treasury,
        chogToken: input.chogToken,
        chogDecimals,
        receipt: null,
        transaction: null,
      });
    }
    return [
      {
        status: "unverified",
        assetKind: "unknown",
        tokenAddress: null,
        symbol: "Unknown",
        decimals: null,
        amountRaw: null,
        sender: null,
        recipient: null,
        blockNumber: null,
        detail: `The receipt could not be read. ${message}`.slice(0, 300),
      },
    ];
  }
}
