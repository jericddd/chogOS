import "server-only";
import { createPublicClient, getAddress, http, zeroAddress, type Address } from "viem";
import { withTimeout } from "@/lib/ai/invocation";
import { addresses } from "@/lib/blockchain/addresses";
import { getChain } from "@/lib/blockchain/chains";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { bankAbi, bankSnapshotProblem, spendKeys } from "@/lib/chogbank/payout";
import type { AppConfig } from "@/lib/config/env";
import { walletTokenAbi } from "@/lib/wallets/issuer";

const RPC = "https://rpc.monad.xyz";
const RPC_CALL_MS = 8_000;

function rpcReason(error: unknown): string {
  const text = error instanceof Error ? error.message : "rpc failed";
  return text.replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, 180);
}

const CHOG_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type TreasuryChainFacts = {
  monBalance: bigint;
  chogBalance: bigint;
  chogDecimals: number;
  windowId: bigint;
  windowSeconds: bigint;
  maxPerTxMon: bigint;
  maxCitizenWindowMon: bigint;
  maxAggregateWindowMon: bigint;
  maxPerTxChog: bigint;
  maxCitizenWindowChog: bigint;
  maxAggregateWindowChog: bigint;
  observedWindowSpentMon: bigint;
};

export type WalletObservation = {
  codeBytes: number;
  identityMatches: boolean;
};

function chainClient(config: AppConfig) {
  return createPublicClient({
    chain: getChain(143),
    transport: http(config.rpcUrl ?? RPC, { timeout: 20_000, retryCount: 0 }),
  });
}

/** Live ChogBank balances, immutable caps, and MON already spent in the current window. */
export async function readTreasuryChain(config: AppConfig): Promise<{ ok: true; facts: TreasuryChainFacts } | { ok: false; reason: string }> {
  try {
    const client = chainClient(config);
    const bank = MAINNET_CHOG_BANK;
    const read = <
      T extends
        | "authorizer"
        | "configuredChainId"
        | "genesis"
        | "chogToken"
        | "windowSeconds"
        | "maxAuthorizationTtl"
        | "maxPerTxMon"
        | "maxCitizenWindowMon"
        | "maxAggregateWindowMon"
        | "maxPerTxChog"
        | "maxCitizenWindowChog"
        | "maxAggregateWindowChog",
    >(
      functionName: T,
    ) => client.readContract({ address: bank, abi: bankAbi, functionName });
    const bound = <T,>(call: Promise<T>) => withTimeout(call, RPC_CALL_MS, "ChogBank read");
    const [
      authorizer,
      chainId,
      genesis,
      chogToken,
      windowSeconds,
      maxAuthorizationTtl,
      maxPerTxMon,
      maxCitizenWindowMon,
      maxAggregateWindowMon,
      maxPerTxChog,
      maxCitizenWindowChog,
      maxAggregateWindowChog,
      monBalance,
      chogBalance,
      chogDecimals,
      block,
    ] = await Promise.all([
      bound(read("authorizer")),
      bound(read("configuredChainId")),
      bound(read("genesis")),
      bound(read("chogToken")),
      bound(read("windowSeconds")),
      bound(read("maxAuthorizationTtl")),
      bound(read("maxPerTxMon")),
      bound(read("maxCitizenWindowMon")),
      bound(read("maxAggregateWindowMon")),
      bound(read("maxPerTxChog")),
      bound(read("maxCitizenWindowChog")),
      bound(read("maxAggregateWindowChog")),
      bound(client.getBalance({ address: bank })),
      bound(client.readContract({ address: addresses.chogToken, abi: CHOG_ABI, functionName: "balanceOf", args: [bank] })),
      bound(client.readContract({ address: addresses.chogToken, abi: CHOG_ABI, functionName: "decimals" })),
      bound(client.getBlock({ blockTag: "latest" })),
    ]);
    const problem = bankSnapshotProblem({
      authorizer,
      chainId,
      genesis,
      chogToken,
      windowSeconds,
      maxAuthorizationTtl,
      maxPerTxMon,
      maxCitizenWindowMon,
      maxAggregateWindowMon,
      maxPerTxChog,
      maxCitizenWindowChog,
      maxAggregateWindowChog,
      monBalance,
      chogBalance,
    });
    if (problem) return { ok: false, reason: `${problem} No allocation was requested.` };
    if (windowSeconds <= 0n) return { ok: false, reason: "ChogBank's spending window was not read. No allocation was requested." };
    const windowId = block.timestamp / windowSeconds;
    const spent = await withTimeout(
      client.readContract({
        address: bank,
        abi: bankAbi,
        functionName: "spentInWindow",
        args: [spendKeys(zeroAddress, windowId, 0n).window],
      }),
      RPC_CALL_MS,
      "ChogBank window spend",
    );
    return {
      ok: true,
      facts: {
        monBalance,
        chogBalance,
        chogDecimals: Number(chogDecimals),
        windowId,
        windowSeconds,
        maxPerTxMon,
        maxCitizenWindowMon,
        maxAggregateWindowMon,
        maxPerTxChog,
        maxCitizenWindowChog,
        maxAggregateWindowChog,
        observedWindowSpentMon: spent,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `ChogBank balances and caps were not read (${rpcReason(error)}). No allocation was requested.`,
    };
  }
}

export type ChainReadGap = { tokenId: string; reason: string };

/** Code and token identity. One failed wallet is reported and left out. */
export async function observeCitizenWallets(
  config: AppConfig,
  wallets: readonly { tokenId: string; accountAddress: string }[],
): Promise<{ code: Map<string, WalletObservation>; unread: ChainReadGap[] }> {
  const code = new Map<string, WalletObservation>();
  const unread: ChainReadGap[] = [];
  if (wallets.length === 0) return { code, unread };
  const client = chainClient(config);
  const chunk = 4;
  for (let index = 0; index < wallets.length; index += chunk) {
    const slice = wallets.slice(index, index + chunk);
    await Promise.all(
      slice.map(async (wallet) => {
        try {
          const row = await withTimeout(readWalletCode(client, wallet), RPC_CALL_MS, `wallet ${wallet.tokenId}`);
          if (!row) {
            unread.push({ tokenId: wallet.tokenId, reason: "the wallet code call failed" });
            return;
          }
          code.set(row.tokenId, row.observation);
        } catch (error) {
          unread.push({ tokenId: wallet.tokenId, reason: rpcReason(error) });
        }
      }),
    );
  }
  return { code, unread };
}

async function readWalletCode(
  client: ReturnType<typeof chainClient>,
  wallet: { tokenId: string; accountAddress: string },
): Promise<{ tokenId: string; observation: WalletObservation } | null> {
  try {
    const account = getAddress(wallet.accountAddress) as Address;
    const code = await client.getBytecode({ address: account });
    const codeBytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    if (codeBytes < 1) return { tokenId: wallet.tokenId, observation: { codeBytes: 0, identityMatches: false } };
    const token = await client.readContract({ address: account, abi: walletTokenAbi, functionName: "token" });
    const identityMatches =
      token[0] === 143n && token[1].toLowerCase() === addresses.chogGenesis.toLowerCase() && token[2] === BigInt(wallet.tokenId);
    return { tokenId: wallet.tokenId, observation: { codeBytes, identityMatches } };
  } catch {
    return null;
  }
}

/** Per-citizen MON already spent. Unread citizens are listed instead of failing the whole set. */
export async function readCitizenMonSpent(
  config: AppConfig,
  tokenIds: readonly string[],
  windowId: bigint,
): Promise<{ spent: Map<string, bigint>; unread: ChainReadGap[] }> {
  const spent = new Map<string, bigint>();
  const unread: ChainReadGap[] = [];
  if (tokenIds.length === 0) return { spent, unread };
  const client = chainClient(config);
  const chunk = 4;
  for (let index = 0; index < tokenIds.length; index += chunk) {
    const slice = tokenIds.slice(index, index + chunk);
    await Promise.all(
      slice.map(async (tokenId) => {
        try {
          const value = await withTimeout(
            client.readContract({
              address: MAINNET_CHOG_BANK,
              abi: bankAbi,
              functionName: "spentByCitizen",
              args: [spendKeys(zeroAddress, windowId, BigInt(tokenId)).citizen],
            }),
            RPC_CALL_MS,
            `citizen ${tokenId} MON spend`,
          );
          spent.set(tokenId, value);
        } catch (error) {
          unread.push({ tokenId, reason: rpcReason(error) });
        }
      }),
    );
  }
  return { spent, unread };
}
