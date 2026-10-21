import "server-only";
import { connection } from "next/server";
import { getAddress, type Address, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { createChainClient } from "@/lib/blockchain/public-client";
import { readAppConfig, type AppConfig } from "@/lib/config/env";
import { openEconomyClient } from "@/lib/economy/db";
import {
  CHOG_BANK_EVENTS,
  decodeBankLog,
  decodeDirectChogTransfer,
  withoutFundedTransfers,
  type DecodedDistribution,
  type DecodedFunding,
} from "@/lib/economy/treasury-logs";
import {
  knownAddressProblem,
  pendingInspection,
  presentOwnerlessTreasury,
  type CallResult,
  type ChainCaps,
  type ChogBankPublicView,
  type OwnerlessInspection,
  type StoredTreasuryDecision,
} from "@/lib/economy/treasury-public";
import { publicRpcError } from "@/lib/verify/anchor";

const TIMEOUT_MS = 4_000;
const LOG_SPAN = 99n;

const BANK_ABI = [
  { type: "function", name: "configuredChainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "genesis", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "chogToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "authorizer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "windowSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAuthorizationTtl", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxPerTxMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxCitizenWindowMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAggregateWindowMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxPerTxChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxCitizenWindowChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAggregateWindowChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const TOKEN_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

const CALLS = {
  owner: "0x8da5cb5b",
  admin: "0xf851a440",
  implementation: "0x5c60da1b",
  upgradeTo: "0x3659cfe60000000000000000000000000000000000000000000000000000000000000000",
} as const;

export async function loadOwnerlessChogBank(): Promise<ChogBankPublicView> {
  await connection();
  const config = readAppConfig();
  const [inspection, decisions, chainActivity] = await Promise.all([
    inspectContract(config),
    loadDecisions(),
    Promise.resolve({ distributions: [] as DecodedDistribution[], funding: [] as DecodedFunding[], read: false }),
  ]);
  const activity =
    inspection.codeBytes && inspection.codeBytes > 0 && inspection.configuredAddress
      ? await within(readRecentActivity(config, getAddress(inspection.configuredAddress))).catch(() => ({
          distributions: [] as DecodedDistribution[],
          funding: [] as DecodedFunding[],
          read: false,
        }))
      : chainActivity;
  return presentOwnerlessTreasury({
    inspection,
    decisions: decisions.rows,
    decisionsLoaded: decisions.loaded,
    distributions: activity.distributions,
    fundingRows: activity.funding,
    fundingLogsRead: activity.read,
  });
}

async function inspectContract(config: AppConfig): Promise<OwnerlessInspection> {
  const inspection = pendingInspection(config.chainId);
  const raw = config.chogBankContractAddress;
  if (!raw) return inspection;
  inspection.configuredAddress = raw;
  inspection.blockedReason = knownAddressProblem(raw);
  if (config.chogBankGasAddress && raw.toLowerCase() === config.chogBankGasAddress.toLowerCase()) {
    inspection.blockedReason = "That address is the gas-paying address, not the ownerless treasury.";
  }
  if (inspection.blockedReason || config.chainId !== 143) return inspection;

  inspection.deploymentTx = config.chogBankDeploymentTx ?? null;
  try {
    const client = createChainClient(143, config.rpcUrl);
    const empty = await within(fillInspection(client, raw, inspection));
    if (!empty && inspection.codeBytes && inspection.codeBytes > 0 && config.chogBankDeploymentTx) {
      inspection.deploymentTxVerified = await within(deploymentCreatedContract(client, config.chogBankDeploymentTx, raw)).catch(() => false);
    }
  } catch (error) {
    inspection.readError = inspection.readError ?? publicRpcError(error, "The chain read failed.");
  }
  return inspection;
}

async function deploymentCreatedContract(
  client: ReturnType<typeof createChainClient>,
  hash: `0x${string}`,
  bank: Address,
): Promise<boolean> {
  const receipt = await client.getTransactionReceipt({ hash });
  return receipt.status === "success" && receipt.contractAddress?.toLowerCase() === bank.toLowerCase();
}

async function fillInspection(client: ReturnType<typeof createChainClient>, raw: Address, inspection: OwnerlessInspection): Promise<boolean> {
    const code = await client.getCode({ address: raw });
    inspection.codeBytes = !code || code === "0x" ? 0 : (code.length - 2) / 2;
    if (!inspection.codeBytes) return true;

    const read = async (name: (typeof BANK_ABI)[number]["name"]) => {
      try {
        return await client.readContract({ address: raw, abi: BANK_ABI, functionName: name });
      } catch {
        return null;
      }
    };
    const [chainId, genesis, chogToken, authorizer] = await Promise.all([
      read("configuredChainId"),
      read("genesis"),
      read("chogToken"),
      read("authorizer"),
    ]);
    inspection.observedChainId = typeof chainId === "bigint" && chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(chainId) : null;
    inspection.genesis = typeof genesis === "string" ? genesis : null;
    inspection.chogToken = typeof chogToken === "string" ? chogToken : null;
    inspection.authorizer = typeof authorizer === "string" ? authorizer : null;
    const [implementationSlot, adminSlot, ownerCall, adminCall, implementationCall, upgradeCall, chainCaps, monRaw, chogRaw, chogDecimals] =
      await Promise.all([
        storage(client, raw, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"),
        storage(client, raw, "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"),
        probe(client, raw, CALLS.owner),
        probe(client, raw, CALLS.admin),
        probe(client, raw, CALLS.implementation),
        probe(client, raw, CALLS.upgradeTo),
        readCaps(client, raw),
        client.getBalance({ address: raw }).catch(() => null),
        client.readContract({ address: addresses.chogToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [raw] }).catch(() => null),
        client.readContract({ address: addresses.chogToken, abi: TOKEN_ABI, functionName: "decimals" }).catch(() => null),
      ]);
    inspection.implementationSlot = implementationSlot;
    inspection.adminSlot = adminSlot;
    inspection.ownerCall = ownerCall;
    inspection.adminCall = adminCall;
    inspection.implementationCall = implementationCall;
    inspection.upgradeCall = upgradeCall;
    inspection.chainCaps = chainCaps;
    inspection.monRaw = monRaw;
    inspection.chogRaw = chogRaw;
    inspection.chogDecimals = chogDecimals == null ? null : Number(chogDecimals);
    return false;
}

async function readCaps(client: ReturnType<typeof createChainClient>, address: Address): Promise<ChainCaps | null> {
  try {
    const names = [
      "windowSeconds",
      "maxAuthorizationTtl",
      "maxPerTxMon",
      "maxCitizenWindowMon",
      "maxAggregateWindowMon",
      "maxPerTxChog",
      "maxCitizenWindowChog",
      "maxAggregateWindowChog",
    ] as const;
    const values = await Promise.all(names.map((name) => client.readContract({ address, abi: BANK_ABI, functionName: name })));
    const [windowSeconds, maxAuthorizationTtl, maxPerTxMon, maxCitizenWindowMon, maxAggregateWindowMon, maxPerTxChog, maxCitizenWindowChog, maxAggregateWindowChog] =
      values;
    if (
      windowSeconds > BigInt(Number.MAX_SAFE_INTEGER) ||
      maxAuthorizationTtl > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }
    return {
      windowSeconds: Number(windowSeconds),
      maxAuthorizationTtl: Number(maxAuthorizationTtl),
      maxPerTxMon,
      maxCitizenWindowMon,
      maxAggregateWindowMon,
      maxPerTxChog,
      maxCitizenWindowChog,
      maxAggregateWindowChog,
    };
  } catch {
    return null;
  }
}

async function storage(client: ReturnType<typeof createChainClient>, address: Address, slot: Hex): Promise<string | null> {
  try {
    const value = await client.getStorageAt({ address, slot });
    return value ?? null;
  } catch {
    return null;
  }
}

async function probe(client: ReturnType<typeof createChainClient>, address: Address, data: Hex): Promise<CallResult> {
  try {
    const result = await client.call({ to: address, data });
    return result.data && result.data !== "0x" ? "returned" : "reverted";
  } catch {
    return "reverted";
  }
}

async function readRecentActivity(config: AppConfig, bank: Address): Promise<{
  distributions: DecodedDistribution[];
  funding: DecodedFunding[];
  read: boolean;
}> {
  const client = createChainClient(143, config.rpcUrl);
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOG_SPAN ? latest - LOG_SPAN : 0n;
  const fundedAbi = CHOG_BANK_EVENTS[0];
  const distributedAbi = CHOG_BANK_EVENTS[1];
  const [fundedLogs, distributedLogs, transferLogs] = await Promise.all([
    client.getLogs({ address: bank, event: fundedAbi, fromBlock, toBlock: latest }),
    client.getLogs({ address: bank, event: distributedAbi, fromBlock, toBlock: latest }),
    client.getLogs({ address: addresses.chogToken, event: TRANSFER_EVENT, args: { to: bank }, fromBlock, toBlock: latest }),
  ]);
  const receipts = new Map<string, Promise<boolean>>();
  const accepted = (hash: Hex, blockNumber: bigint | null) => {
    const key = hash.toLowerCase();
    const cached = receipts.get(key);
    if (cached) return cached;
    const pending = client
      .getTransactionReceipt({ hash })
      .then((receipt) => receipt.status === "success" && blockNumber != null && receipt.blockNumber === blockNumber)
      .catch(() => false);
    receipts.set(key, pending);
    return pending;
  };
  const funding: DecodedFunding[] = [];
  for (const log of fundedLogs.slice(0, 8)) {
    const decoded = decodeBankLog(log);
    if (!decoded || !("kind" in decoded)) continue;
    if (await accepted(log.transactionHash, log.blockNumber)) funding.push(decoded);
  }
  for (const log of transferLogs.slice(0, 8)) {
    const decoded = decodeDirectChogTransfer(log);
    if (!decoded) continue;
    if (await accepted(log.transactionHash, log.blockNumber)) funding.push(decoded);
  }
  const distributions: DecodedDistribution[] = [];
  for (const log of distributedLogs.slice(0, 8)) {
    const decoded = decodeBankLog(log);
    if (!decoded || !("decisionId" in decoded)) continue;
    if (await accepted(log.transactionHash, log.blockNumber)) distributions.push(decoded);
  }
  return { distributions, funding: withoutFundedTransfers(funding), read: true };
}

async function loadDecisions(): Promise<{ loaded: boolean; rows: StoredTreasuryDecision[] }> {
  const client = openEconomyClient();
  if (!client) return { loaded: false, rows: [] };
  const { data, error } = await client
    .from("ai_decisions")
    .select("id, status, rationale, output, created_at")
    .eq("purpose", "treasury_allocation")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !data) return { loaded: false, rows: [] };
  return {
    loaded: true,
    rows: (data as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      status: String(row.status),
      rationale: typeof row.rationale === "string" ? row.rationale : null,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      output: row.output,
    })),
  };
}

function within<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The chain read timed out.")), TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("The chain read failed."));
      },
    );
  });
}
