import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { getChain } from "@/lib/blockchain/chains";
import { publicRpcError } from "@/lib/verify/anchor";
import { remaining } from "@/lib/economy/amounts";

export const NATIVE_MON_DECIMALS = 18;

export const TREASURY_STATUSES = [
  "not_configured",
  "observed",
  "stale",
  "unavailable",
  "wrong_chain",
  "malformed",
  "timed_out",
] as const;

export type TreasuryStatus = (typeof TREASURY_STATUSES)[number];

export type AssetSnapshot = {
  symbol: "MON" | "CHOG";
  raw: bigint | null;
  decimals: number | null;
};

export type TreasurySnapshot = {
  status: TreasuryStatus;
  configured: boolean;
  /** The only chain this observer will treat as authoritative. */
  chainId: 143;
  observedChainId: number | null;
  address: Address | null;
  blockNumber: bigint | null;
  observedAt: string | null;
  mon: AssetSnapshot;
  chog: AssetSnapshot;
  /** Spendable MON after gas, deployment, and MON capital holds. Null unless the read is fresh. */
  unallocatedMon: bigint | null;
  /** Spendable $CHOG after CHOG capital holds. Null unless the read is fresh. */
  unallocatedChog: bigint | null;
  reason: string;
};

export type TreasuryReader = {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getNativeBalance(address: Address): Promise<bigint>;
  getTokenBalance(token: Address, holder: Address): Promise<bigint>;
  getTokenDecimals(token: Address): Promise<number>;
};

const EMPTY_MON: AssetSnapshot = { symbol: "MON", raw: null, decimals: null };
const EMPTY_CHOG: AssetSnapshot = { symbol: "CHOG", raw: null, decimals: null };
const READ_TIMEOUT_MS = 4_000;

const TOKEN_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export function emptySnapshot(status: TreasuryStatus, reason: string, address: Address | null = null): TreasurySnapshot {
  return {
    status,
    configured: status !== "not_configured",
    chainId: 143,
    observedChainId: null,
    address,
    blockNumber: null,
    observedAt: null,
    mon: EMPTY_MON,
    chog: EMPTY_CHOG,
    unallocatedMon: null,
    unallocatedChog: null,
    reason,
  };
}

export function economicAddressProblem(
  candidate: string | null | undefined,
  reserved: { nftTreasury: Address; nft: Address; token: Address; gas: Address | null; also?: Address | null },
): string | null {
  if (!candidate) {
    return "Economic treasury address is not configured.";
  }
  let address: Address;
  try {
    address = getAddress(candidate);
  } catch {
    return "Economic treasury address is malformed.";
  }
  if (address.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return "The zero address cannot be the economic treasury.";
  }
  if (address.toLowerCase() === reserved.nftTreasury.toLowerCase()) {
    return "That address is the ChogTreasury NFT wallet, not the economic treasury.";
  }
  if (address.toLowerCase() === reserved.nft.toLowerCase() || address.toLowerCase() === reserved.token.toLowerCase()) {
    return "That address is a Chog contract, not the economic treasury.";
  }
  if (reserved.gas && address.toLowerCase() === reserved.gas.toLowerCase()) {
    return "The gas-paying address cannot be reused as the economic treasury.";
  }
  if (reserved.also && address.toLowerCase() === reserved.also.toLowerCase()) {
    return "That address is the configured NFT treasury, not the economic treasury.";
  }
  return null;
}

function decimalsOk(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 36;
}

function balanceOk(value: bigint): boolean {
  return value >= 0n;
}

/**
 * Turn one finished read into a snapshot. A stale, wrong-chain, or failed read
 * does not become a zero balance and does not unlock spending.
 */
export function assessTreasuryRead(input: {
  address: Address | null;
  read: {
    chainId: number;
    blockNumber: bigint;
    observedAt: string;
    nativeRaw: bigint;
    tokenRaw: bigint;
    tokenDecimals: number;
  } | null;
  error?: "timeout" | "rpc" | "malformed" | null;
  errorDetail?: string | null;
  nowMs: number;
  maxAgeMs: number;
  reservedGasWei?: bigint;
  reservedDeploymentWei?: bigint;
  allocatedMon?: bigint;
  allocatedChog?: bigint;
}): TreasurySnapshot {
  if (!input.address) {
    return emptySnapshot("not_configured", "Economic treasury address is not configured.");
  }
  if (input.error === "timeout") {
    return emptySnapshot("timed_out", "The read-only RPC did not respond in time.", input.address);
  }
  if (input.error === "malformed") {
    return emptySnapshot("malformed", input.errorDetail ?? "The treasury read was malformed.", input.address);
  }
  if (input.error === "rpc" || !input.read) {
    return emptySnapshot("unavailable", input.errorDetail ?? "The treasury balance could not be read.", input.address);
  }
  const read = input.read;
  if (!Number.isSafeInteger(read.chainId) || read.blockNumber < 0n) {
    return emptySnapshot("malformed", "The treasury read was malformed.", input.address);
  }
  if (read.chainId !== 143) {
    return {
      ...emptySnapshot("wrong_chain", `Treasury read came from chain ${read.chainId}, not Monad mainnet 143.`, input.address),
      observedChainId: read.chainId,
    };
  }
  if (!balanceOk(read.nativeRaw) || !balanceOk(read.tokenRaw) || !decimalsOk(read.tokenDecimals)) {
    return emptySnapshot("malformed", "A balance or token decimal was not a usable integer.", input.address);
  }
  const observedMs = Date.parse(read.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > input.nowMs + 5_000) {
    return emptySnapshot("malformed", "The treasury observation time is not usable.", input.address);
  }
  const mon: AssetSnapshot = { symbol: "MON", raw: read.nativeRaw, decimals: NATIVE_MON_DECIMALS };
  const chog: AssetSnapshot = { symbol: "CHOG", raw: read.tokenRaw, decimals: read.tokenDecimals };
  const base = {
    configured: true,
    chainId: 143 as const,
    observedChainId: 143,
    address: input.address,
    blockNumber: read.blockNumber,
    observedAt: read.observedAt,
    mon,
    chog,
    unallocatedMon: null,
    unallocatedChog: null,
  };
  if (input.nowMs - observedMs > input.maxAgeMs) {
    return { ...base, status: "stale", reason: "The treasury observation is stale and is not spendable." };
  }
  const reservedMon = (input.reservedGasWei ?? 0n) + (input.reservedDeploymentWei ?? 0n) + (input.allocatedMon ?? 0n);
  return {
    ...base,
    status: "observed",
    unallocatedMon: remaining(read.nativeRaw, reservedMon),
    unallocatedChog: remaining(read.tokenRaw, input.allocatedChog ?? 0n),
    reason: "Fresh mainnet balances. They are not a spending authorization.",
  };
}

export async function readEconomicTreasury(input: {
  address: Address | null;
  token?: Address;
  rpcUrl?: string;
  nowMs: number;
  maxAgeMs: number;
  reader?: TreasuryReader;
  timeoutMs?: number;
  reservedGasWei?: bigint;
  reservedDeploymentWei?: bigint;
  allocatedMon?: bigint;
  allocatedChog?: bigint;
}): Promise<TreasurySnapshot> {
  if (!input.address) {
    return emptySnapshot("not_configured", "Economic treasury address is not configured.");
  }
  const token = input.token ?? addresses.chogToken;
  if (getAddress(token) !== addresses.chogToken) {
    return emptySnapshot("malformed", "The $CHOG balance must be read from the canonical token contract.", input.address);
  }
  if (!input.reader && !input.rpcUrl) {
    return emptySnapshot("unavailable", "No read-only RPC is configured, so balances were not read.", input.address);
  }
  const reader = input.reader ?? viemReader(input.rpcUrl!);
  const attempt = withDeadline(readWith(reader, input.address, token), input.timeoutMs ?? READ_TIMEOUT_MS + 1_000);
  const result = await attempt;
  if (!result.ok) {
    return assessTreasuryRead({
      address: input.address,
      read: null,
      error: result.error,
      errorDetail: result.detail,
      nowMs: input.nowMs,
      maxAgeMs: input.maxAgeMs,
    });
  }
  return assessTreasuryRead({
    address: input.address,
    read: { ...result, observedAt: new Date(input.nowMs).toISOString() },
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    reservedGasWei: input.reservedGasWei,
    reservedDeploymentWei: input.reservedDeploymentWei,
    allocatedMon: input.allocatedMon,
    allocatedChog: input.allocatedChog,
  });
}

type ReadOk = {
  ok: true;
  chainId: number;
  blockNumber: bigint;
  nativeRaw: bigint;
  tokenRaw: bigint;
  tokenDecimals: number;
};

type ReadFail = { ok: false; error: "timeout" | "rpc" | "malformed"; detail: string };

async function readWith(reader: TreasuryReader, holder: Address, token: Address): Promise<ReadOk | ReadFail> {
  try {
    const chainId = await reader.getChainId();
    if (chainId !== 143) {
      return {
        ok: true,
        chainId,
        blockNumber: 0n,
        nativeRaw: 0n,
        tokenRaw: 0n,
        tokenDecimals: 0,
      };
    }
    const [blockNumber, nativeRaw, tokenRaw, tokenDecimals] = await Promise.all([
      reader.getBlockNumber(),
      reader.getNativeBalance(holder),
      reader.getTokenBalance(token, holder),
      reader.getTokenDecimals(token),
    ]);
    return { ok: true, chainId, blockNumber, nativeRaw, tokenRaw, tokenDecimals };
  } catch (error) {
    const detail = publicRpcError(error, "The treasury balance could not be read.");
    if (/timed out|timeout/i.test(detail)) {
      return { ok: false, error: "timeout", detail: "The read-only RPC did not respond in time." };
    }
    return { ok: false, error: "rpc", detail };
  }
}

function withDeadline(promise: Promise<ReadOk | ReadFail>, timeoutMs: number): Promise<ReadOk | ReadFail> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: "timeout", detail: "The read-only RPC did not respond in time." }),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: false, error: "timeout", detail: "The read-only RPC did not respond in time." });
      },
    );
  });
}

function viemReader(rpcUrl: string): TreasuryReader {
  const client: PublicClient = createPublicClient({
    chain: getChain(143),
    transport: http(rpcUrl, { timeout: READ_TIMEOUT_MS, retryCount: 0 }),
  });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: async () => {
      const block = await client.getBlock({ blockTag: "latest" });
      if (block.number == null) {
        throw new Error("The latest block number was missing.");
      }
      return block.number;
    },
    getNativeBalance: (address) => client.getBalance({ address }),
    getTokenBalance: (token, holder) =>
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [holder] }),
    getTokenDecimals: async (token) =>
      Number(await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "decimals" })),
  };
}
