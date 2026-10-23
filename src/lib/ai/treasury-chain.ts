import "server-only";
import { createPublicClient, getAddress, http, zeroAddress, type Address } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { getChain } from "@/lib/blockchain/chains";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { bankAbi, bankSnapshotProblem, spendKeys } from "@/lib/chogbank/payout";
import type { AppConfig } from "@/lib/config/env";
import { walletTokenAbi } from "@/lib/wallets/issuer";

const RPC = "https://rpc.monad.xyz";

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
      read("authorizer"),
      read("configuredChainId"),
      read("genesis"),
      read("chogToken"),
      read("windowSeconds"),
      read("maxAuthorizationTtl"),
      read("maxPerTxMon"),
      read("maxCitizenWindowMon"),
      read("maxAggregateWindowMon"),
      read("maxPerTxChog"),
      read("maxCitizenWindowChog"),
      read("maxAggregateWindowChog"),
      client.getBalance({ address: bank }),
      client.readContract({ address: addresses.chogToken, abi: CHOG_ABI, functionName: "balanceOf", args: [bank] }),
      client.readContract({ address: addresses.chogToken, abi: CHOG_ABI, functionName: "decimals" }),
      client.getBlock({ blockTag: "latest" }),
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
    const spent = await client.readContract({
      address: bank,
      abi: bankAbi,
      functionName: "spentInWindow",
      args: [spendKeys(zeroAddress, windowId, 0n).window],
    });
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
  } catch {
    return { ok: false, reason: "ChogBank balances and caps were not read. No allocation was requested." };
  }
}

/** Code and token identity for candidate wallets. Any unread wallet fails the whole set. */
export async function observeCitizenWallets(
  config: AppConfig,
  wallets: readonly { tokenId: string; accountAddress: string }[],
): Promise<Map<string, WalletObservation> | null> {
  if (wallets.length === 0) return new Map();
  const client = chainClient(config);
  const observed = new Map<string, WalletObservation>();
  const chunk = 8;
  for (let index = 0; index < wallets.length; index += chunk) {
    const slice = wallets.slice(index, index + chunk);
    const rows = await Promise.all(slice.map((wallet) => readWalletCode(client, wallet)));
    for (const row of rows) {
      if (!row) return null;
      observed.set(row.tokenId, row.observation);
    }
  }
  return observed;
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

export async function readCitizenMonSpent(
  config: AppConfig,
  tokenIds: readonly string[],
  windowId: bigint,
): Promise<Map<string, bigint> | null> {
  if (tokenIds.length === 0) return new Map();
  try {
    const client = chainClient(config);
    const entries = await Promise.all(
      tokenIds.map(async (tokenId) => {
        const spent = await client.readContract({
          address: MAINNET_CHOG_BANK,
          abi: bankAbi,
          functionName: "spentByCitizen",
          args: [spendKeys(zeroAddress, windowId, BigInt(tokenId)).citizen],
        });
        return [tokenId, spent] as const;
      }),
    );
    return new Map(entries);
  } catch {
    return null;
  }
}
