/**
 * Broadcasts accepted ChogBank allocations on Monad mainnet.
 * GitHub Actions holds the authorizer key and the gas key. Next.js does not import this file.
 * The only contract write is ChogBank.distribute. The wallet agent key is not read.
 */
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHOG_BANK_DEPLOYMENT_BLOCK,
  MAINNET_CHOG_BANK,
  MAINNET_CHOG_BANK_AUTHORIZER,
  MAINNET_PAYOUT_GAS,
} from "../src/lib/chogbank/bank";
import {
  ALLOCATION_TYPES,
  bankAbi,
  broadcastPendingPayouts,
  chogBankDomain,
  distributedEvent,
  parsePayoutList,
  payoutEndpoint,
  spendKeys,
  type BankSnapshot,
} from "../src/lib/chogbank/payout";
import { addresses } from "../src/lib/blockchain/addresses";
import { getChain } from "../src/lib/blockchain/chains";
import { missingIssuerExitCode, redactSecrets, SECRETS_URL } from "../src/lib/wallets/issue-broadcast";

const RPC = "https://rpc.monad.xyz";

function readPrivateKey(name: "CHOG_BANK_AUTHORIZER_KEY" | "WALLET_ISSUER_GAS_KEY"): Hex | null {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) return null;
  const body = raw.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    console.error(`${name} must be a 32-byte hex private key.`);
    process.exit(1);
  }
  return `0x${body}` as Hex;
}

function secretValues(): string[] {
  return [process.env.CHOG_BANK_AUTHORIZER_KEY ?? "", process.env.WALLET_ISSUER_GAS_KEY ?? "", process.env.AI_RUNNER_SECRET ?? ""].filter(
    (value) => value.trim().length >= 16,
  );
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactSecrets(message, secretValues()).slice(0, 500));
  process.exit(1);
}

async function main(): Promise<void> {
  const authorizerKey = readPrivateKey("CHOG_BANK_AUTHORIZER_KEY");
  const gasKey = readPrivateKey("WALLET_ISSUER_GAS_KEY");
  const secret = process.env.AI_RUNNER_SECRET?.trim() ?? "";
  if (!authorizerKey || !gasKey || !secret) {
    console.log("Add repository secrets CHOG_BANK_AUTHORIZER_KEY, WALLET_ISSUER_GAS_KEY, and AI_RUNNER_SECRET.");
    console.log(SECRETS_URL);
    console.log("Copy the authorizer key from your notes. The website does not receive it.");
    process.exit(missingIssuerExitCode(process.env.GITHUB_EVENT_NAME));
  }
  const authorizer = privateKeyToAccount(authorizerKey);
  const gas = privateKeyToAccount(gasKey);
  if (getAddress(authorizer.address) !== MAINNET_CHOG_BANK_AUTHORIZER || getAddress(gas.address) !== MAINNET_PAYOUT_GAS) {
    throw new Error("The payout keys do not match the pinned authorizer and gas wallet. Nothing was signed.");
  }
  const endpoint = payoutEndpoint(process.env.AI_RUNNER_URL);
  const listed = parsePayoutList(await listPayouts(endpoint, secret));
  const chain = getChain(143);
  const transport = http(RPC, { timeout: 20_000, retryCount: 1 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account: gas, chain, transport });
  const result = await broadcastPendingPayouts(listed.decisions, {
    bank: MAINNET_CHOG_BANK,
    authorizer: authorizer.address,
    gas: gas.address,
    monDistributed: listed.monDistributed,
    chainId: () => publicClient.getChainId(),
    snapshot: () => readSnapshot(publicClient),
    now: async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp,
    baseFee: async () => (await publicClient.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n,
    usedDecision: (decisionId) => publicClient.readContract({ address: MAINNET_CHOG_BANK, abi: bankAbi, functionName: "usedDecision", args: [decisionId] }),
    spent: async (asset, windowId, tokenId) => {
      const keys = spendKeys(asset, windowId, tokenId);
      const [citizen, windowSpent] = await Promise.all([
        publicClient.readContract({ address: MAINNET_CHOG_BANK, abi: bankAbi, functionName: "spentByCitizen", args: [keys.citizen] }),
        publicClient.readContract({ address: MAINNET_CHOG_BANK, abi: bankAbi, functionName: "spentInWindow", args: [keys.window] }),
      ]);
      return { citizen, window: windowSpent };
    },
    recipient: (tokenId) =>
      publicClient.readContract({ address: MAINNET_CHOG_BANK, abi: bankAbi, functionName: "payoutRecipient", args: [tokenId] }),
    existing: async (decisionId) => {
      const logs = await publicClient.getLogs({
        address: MAINNET_CHOG_BANK,
        event: distributedEvent,
        args: { decisionId },
        fromBlock: CHOG_BANK_DEPLOYMENT_BLOCK,
        toBlock: "latest",
      });
      const first = logs[0];
      const args = first?.args;
      if (!first || !args?.decisionId || args.tokenId == null || !args.recipient || !args.asset || args.amount == null || args.deadline == null || !args.reasonHash) {
        return null;
      }
      return {
        txHash: first.transactionHash,
        log: {
          decisionId: args.decisionId,
          tokenId: args.tokenId,
          recipient: args.recipient,
          asset: args.asset,
          amount: args.amount,
          deadline: args.deadline,
          reasonHash: args.reasonHash,
        },
      };
    },
    gasBalance: () => publicClient.getBalance({ address: gas.address }),
    sign: (message) =>
      authorizer.signTypedData({
        domain: chogBankDomain(MAINNET_CHOG_BANK),
        types: ALLOCATION_TYPES,
        primaryType: "Allocation",
        message,
      }),
    send: (input) =>
      walletClient.writeContract({
        address: MAINNET_CHOG_BANK,
        abi: bankAbi,
        functionName: "distribute",
        args: [input.decisionId, input.tokenId, input.asset, input.amount, input.deadline, input.reasonHash, input.signature],
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
        chain,
      }),
    receipt: async (hash) => {
      const mined = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      return { status: mined.status, logs: mined.logs };
    },
    confirm: (body) => postPayout(endpoint, secret, body),
    log: (line) => {
      console.log(redactSecrets(line, secretValues()));
    },
  });
  console.log(`Payouts broadcast ${result.paid}. Already on Monad ${result.observed}. Skipped ${result.skipped}. Failed ${result.failed}.`);
  if (result.failed > 0) process.exit(1);
  if (result.paid === 0 && result.observed === 0) console.log("No payable ChogBank allocations.");
}

async function readSnapshot(publicClient: ReturnType<typeof createPublicClient>): Promise<BankSnapshot> {
  const bank = MAINNET_CHOG_BANK;
  const read = <T extends "authorizer" | "configuredChainId" | "genesis" | "chogToken" | "windowSeconds" | "maxAuthorizationTtl" | "maxPerTxMon" | "maxCitizenWindowMon" | "maxAggregateWindowMon" | "maxPerTxChog" | "maxCitizenWindowChog" | "maxAggregateWindowChog">(
    functionName: T,
  ) => publicClient.readContract({ address: bank, abi: bankAbi, functionName });
  const [authorizer, chainId, genesis, chogToken, windowSeconds, maxAuthorizationTtl, maxPerTxMon, maxCitizenWindowMon, maxAggregateWindowMon, maxPerTxChog, maxCitizenWindowChog, maxAggregateWindowChog, monBalance, chogBalance] =
    await Promise.all([
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
      publicClient.getBalance({ address: bank }),
      publicClient.readContract({
        address: addresses.chogToken,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
        functionName: "balanceOf",
        args: [bank],
      }),
    ]);
  return {
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
  };
}

async function listPayouts(endpoint: string, secret: string): Promise<unknown> {
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`The payout list returned HTTP ${response.status}.`);
  return body;
}

async function postPayout(
  endpoint: string,
  secret: string,
  body: { decisionId: Hex; txHash: Hex },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
    const error =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `The payout confirmation returned HTTP ${response.status}.`;
    return { ok: false, error };
  }
  return { ok: true };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`The payout API returned non-JSON (HTTP ${response.status}).`);
  }
}

main().catch(fail);
