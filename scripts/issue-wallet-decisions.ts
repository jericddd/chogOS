/**
 * Broadcasts pending permanent-wallet decisions on Monad mainnet.
 * GitHub Actions holds the two keys. Next.js does not import this file.
 * The only contract write is CitizenAccountFactoryV3 create.
 */
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addresses } from "../src/lib/blockchain/addresses";
import { getChain } from "../src/lib/blockchain/chains";
import {
  issuanceEndpoint,
  issuePendingDecisions,
  missingIssuerExitCode,
  redactSecrets,
  SECRETS_URL,
  type PendingDecision,
} from "../src/lib/wallets/issue-broadcast";
import { decisionMatchesToken, factoryAbi, issuanceTypedData, MAINNET_WALLET_FACTORY } from "../src/lib/wallets/issuer";

const RPC = "https://rpc.monad.xyz";

function readPrivateKey(name: "WALLET_ISSUER_AGENT_KEY" | "WALLET_ISSUER_GAS_KEY"): Hex | null {
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
  return [process.env.WALLET_ISSUER_AGENT_KEY ?? "", process.env.WALLET_ISSUER_GAS_KEY ?? "", process.env.AI_RUNNER_SECRET ?? ""].filter(
    (value) => value.trim().length >= 16,
  );
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactSecrets(message, secretValues()).slice(0, 500));
  process.exit(1);
}

async function main(): Promise<void> {
  const agentKey = readPrivateKey("WALLET_ISSUER_AGENT_KEY");
  const gasKey = readPrivateKey("WALLET_ISSUER_GAS_KEY");
  const secret = process.env.AI_RUNNER_SECRET?.trim() ?? "";
  if (!agentKey || !gasKey || !secret) {
    console.log("Add repository secrets WALLET_ISSUER_AGENT_KEY, WALLET_ISSUER_GAS_KEY, and AI_RUNNER_SECRET.");
    console.log(SECRETS_URL);
    console.log("Copy each key from your notes into GitHub. The website does not receive these keys.");
    process.exit(missingIssuerExitCode(process.env.GITHUB_EVENT_NAME));
  }
  const agent = privateKeyToAccount(agentKey);
  const gas = privateKeyToAccount(gasKey);
  const endpoint = issuanceEndpoint(process.env.AI_RUNNER_URL);
  const listed = await listDecisions(endpoint, secret);
  if (getAddress(listed.factory) !== MAINNET_WALLET_FACTORY) {
    throw new Error("The issuance API factory does not match the pinned factory.");
  }
  const chain = getChain(143);
  const transport = http(RPC, { timeout: 20_000, retryCount: 1 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account: gas, chain, transport });
  const result = await issuePendingDecisions(listed.decisions, {
    factory: MAINNET_WALLET_FACTORY,
    agent: agent.address,
    gas: gas.address,
    chainId: () => publicClient.getChainId(),
    factoryAgent: (factory) => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "agent" }),
    predict: (factory, tokenId) =>
      publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "predict",
        args: [143n, addresses.chogGenesis, tokenId],
      }),
    bytecode: (address) => publicClient.getBytecode({ address }),
    baseFee: async () => (await publicClient.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n,
    balance: () => publicClient.getBalance({ address: gas.address }),
    now: async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp,
    sign: (factory, tokenId, decisionId, deadline) => agent.signTypedData(issuanceTypedData(factory, tokenId, decisionId, deadline)),
    sendCreate: (input) =>
      walletClient.writeContract({
        address: input.factory,
        abi: factoryAbi,
        functionName: "create",
        args: [143n, addresses.chogGenesis, input.tokenId, input.decisionId, input.deadline, input.signature],
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
        chain,
      }),
    receipt: async (hash) => {
      const mined = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      return { status: mined.status, logs: mined.logs };
    },
    confirm: (body) => postDecision(endpoint, secret, body),
    log: (line) => {
      console.log(redactSecrets(line, secretValues()));
    },
  });
  console.log(`Wallets created ${result.issued}. Already on Monad ${result.observed}. Failed ${result.failed}.`);
  if (result.failed > 0) process.exit(1);
  if (result.issued === 0 && result.observed === 0) console.log("No pending wallet decisions.");
}

async function listDecisions(endpoint: string, secret: string): Promise<{ factory: Address; decisions: PendingDecision[] }> {
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`The issuance list returned HTTP ${response.status}.`);
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true) throw new Error(typeof record.error === "string" ? record.error : "The issuance list was refused.");
  if (typeof record.factory !== "string" || !isAddress(record.factory)) throw new Error("The issuance list did not include a factory.");
  if (!Array.isArray(record.decisions)) throw new Error("The issuance list did not include decisions.");
  const decisions: PendingDecision[] = [];
  for (const item of record.decisions) {
    if (!item || typeof item !== "object") throw new Error("A listed decision was not an object.");
    const row = item as Record<string, unknown>;
    const tokenId = typeof row.tokenId === "string" ? row.tokenId : "";
    const decisionId = typeof row.decisionId === "string" ? row.decisionId.toLowerCase() : "";
    if (!decisionMatchesToken(tokenId, decisionId)) throw new Error(`Refusing a listed decision for token ${tokenId || "unknown"}.`);
    decisions.push({ tokenId, decisionId: decisionId as Hex });
  }
  return { factory: getAddress(record.factory), decisions };
}

async function postDecision(
  endpoint: string,
  secret: string,
  body: { decisionId: Hex; txHash?: Hex; observed?: true },
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
        : `The decision update returned HTTP ${response.status}.`;
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
    throw new Error(`The issuance API returned non-JSON (HTTP ${response.status}).`);
  }
}

main().catch(fail);
