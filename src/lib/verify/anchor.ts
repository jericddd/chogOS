import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { getChain, type SupportedChainId } from "@/lib/blockchain/chains";

export const OFFCHAIN_ROOT_SENTENCE =
  "Merkle proof verified offchain; no onchain root commitment has been verified.";

export const TREE_FORMAT_LABEL = "openzeppelin-standard-v1";

export const ANCHOR_ABI = [
  {
    type: "event",
    name: "BatchAnchored",
    inputs: [
      { name: "batchId", type: "bytes32", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: false },
      { name: "fromSeq", type: "uint64", indexed: false },
      { name: "toSeq", type: "uint64", indexed: false },
      { name: "eventCount", type: "uint32", indexed: false },
      { name: "treeFormat", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getBatch",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "merkleRoot", type: "bytes32" },
          { name: "fromSeq", type: "uint64" },
          { name: "toSeq", type: "uint64" },
          { name: "eventCount", type: "uint32" },
          { name: "treeFormat", type: "bytes32" },
          { name: "anchoredAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

export function treeFormatHash(): Hex {
  return keccak256(toBytes(TREE_FORMAT_LABEL));
}

export type AnchorEventJson = {
  batchId: string;
  merkleRoot: string;
  fromSeq: string;
  toSeq: string;
  eventCount: number;
  treeFormat: string;
};

export type AnchorStoredJson = AnchorEventJson & { anchoredAt: string };

/**
 * Raw read-only RPC results. The browser reassesses this object.
 * A boolean from the server is not enough to mark a batch verified.
 */
export type AnchorObservationJson = {
  rpcError: string | null;
  observedChainId: number | null;
  codeBytes: number | null;
  receiptStatus: "success" | "reverted" | "missing" | null;
  receiptBlock: string | null;
  receiptError: string | null;
  event: AnchorEventJson | null;
  storedBatch: AnchorStoredJson | null;
  batchError: string | null;
};

export type AnchorExpectation = {
  chainId: number;
  root: string;
  fromSeq: bigint;
  toSeq: bigint;
  eventCount: number;
  blockNumber: bigint | null;
};

export type AnchorAssessment = {
  ok: boolean;
  pending: boolean;
  reasons: string[];
};

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function lower(value: string): string {
  return value.toLowerCase();
}

function decimal(value: string, label: string): bigint | null {
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    if (label === "eventCount" && parsed > BigInt(2 ** 32 - 1)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function assessAnchorObservation(expected: AnchorExpectation, obs: AnchorObservationJson): AnchorAssessment {
  if (obs.rpcError) {
    return { ok: false, pending: false, reasons: [`RPC error: ${obs.rpcError}`] };
  }
  if (obs.observedChainId == null) {
    return { ok: false, pending: false, reasons: ["The RPC did not return a chain id."] };
  }
  if (obs.observedChainId !== expected.chainId) {
    return {
      ok: false,
      pending: false,
      reasons: ["The contract was read on a different chain than the recorded anchor."],
    };
  }
  if (obs.codeBytes == null) {
    return { ok: false, pending: false, reasons: ["Contract code was not read."] };
  }
  if (obs.codeBytes === 0) {
    return { ok: false, pending: false, reasons: ["The anchor address has no deployed bytecode."] };
  }
  if (obs.receiptError) {
    return { ok: false, pending: false, reasons: [`Receipt read failed: ${obs.receiptError}`] };
  }
  if (obs.receiptStatus == null || obs.receiptStatus === "missing") {
    return {
      ok: false,
      pending: true,
      reasons: ["The anchor transaction has no confirmed receipt yet. A submitted hash is not an onchain root."],
    };
  }
  if (obs.receiptStatus === "reverted") {
    return { ok: false, pending: false, reasons: ["The anchor transaction reverted."] };
  }
  if (expected.blockNumber != null) {
    const receiptBlock = obs.receiptBlock == null ? null : decimal(obs.receiptBlock, "block");
    if (receiptBlock == null || receiptBlock !== expected.blockNumber) {
      return { ok: false, pending: false, reasons: ["The receipt block does not match the recorded anchor block."] };
    }
  }
  if (!obs.event) {
    return { ok: false, pending: false, reasons: ["The receipt has no BatchAnchored event from the anchor contract."] };
  }
  if (!HEX_32.test(obs.event.merkleRoot) || lower(obs.event.merkleRoot) !== lower(expected.root)) {
    return { ok: false, pending: false, reasons: ["The BatchAnchored root does not match this batch root."] };
  }
  const fromSeq = decimal(obs.event.fromSeq, "fromSeq");
  const toSeq = decimal(obs.event.toSeq, "toSeq");
  if (fromSeq == null || toSeq == null || fromSeq !== expected.fromSeq || toSeq !== expected.toSeq) {
    return { ok: false, pending: false, reasons: ["The anchored sequence range does not match this batch."] };
  }
  if (!Number.isInteger(obs.event.eventCount) || obs.event.eventCount !== expected.eventCount) {
    return { ok: false, pending: false, reasons: ["The anchored event count does not match this batch."] };
  }
  if (!HEX_32.test(obs.event.treeFormat) || lower(obs.event.treeFormat) !== lower(treeFormatHash())) {
    return { ok: false, pending: false, reasons: ["The anchored tree format is not openzeppelin-standard-v1."] };
  }
  if (obs.batchError) {
    return { ok: false, pending: false, reasons: [`getBatch failed: ${obs.batchError}`] };
  }
  if (!obs.storedBatch) {
    return { ok: false, pending: false, reasons: ["The contract did not return a stored batch."] };
  }
  const anchoredAt = decimal(obs.storedBatch.anchoredAt, "anchoredAt");
  if (anchoredAt == null || anchoredAt === 0n) {
    return { ok: false, pending: false, reasons: ["The contract has no stored batch for this id."] };
  }
  if (lower(obs.storedBatch.batchId) !== lower(obs.event.batchId)) {
    return { ok: false, pending: false, reasons: ["getBatch was read for a different batch id than the receipt event."] };
  }
  if (lower(obs.storedBatch.merkleRoot) !== lower(expected.root)) {
    return { ok: false, pending: false, reasons: ["The root stored on the contract does not match this batch root."] };
  }
  const storedFrom = decimal(obs.storedBatch.fromSeq, "fromSeq");
  const storedTo = decimal(obs.storedBatch.toSeq, "toSeq");
  if (storedFrom !== expected.fromSeq || storedTo !== expected.toSeq) {
    return { ok: false, pending: false, reasons: ["The stored sequence range does not match this batch."] };
  }
  if (obs.storedBatch.eventCount !== expected.eventCount) {
    return { ok: false, pending: false, reasons: ["The stored event count does not match this batch."] };
  }
  if (lower(obs.storedBatch.treeFormat) !== lower(treeFormatHash())) {
    return { ok: false, pending: false, reasons: ["The stored tree format is not openzeppelin-standard-v1."] };
  }
  return {
    ok: true,
    pending: false,
    reasons: [
      "The live chain id, deployed bytecode, BatchAnchored receipt, and getBatch root, range, count, and tree format match this batch.",
    ],
  };
}

export function emptyObservation(patch: Partial<AnchorObservationJson> = {}): AnchorObservationJson {
  return {
    rpcError: null,
    observedChainId: null,
    codeBytes: null,
    receiptStatus: null,
    receiptBlock: null,
    receiptError: null,
    event: null,
    storedBatch: null,
    batchError: null,
    ...patch,
  };
}

export function publicRpcError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(authorization|bearer|api[_-]?key|service[_-]?role)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 300);
}

const RPC_TIMEOUT_MS = 4_000;

function withDeadline<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), RPC_TIMEOUT_MS + 1_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function codeBytes(code: Hex | undefined): number {
  if (!code) {
    return 0;
  }
  const body = code.startsWith("0x") ? code.slice(2) : code;
  if (body.length === 0 || /^0+$/.test(body)) {
    return 0;
  }
  return body.length / 2;
}

function publicClient(rpcUrl: string, chainId: SupportedChainId) {
  return createPublicClient({
    chain: getChain(chainId),
    transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }),
  });
}

function eventFromReceipt(receipt: TransactionReceipt, contract: Address, expectedRoot: Hex): AnchorEventJson | null {
  const wanted = contract.toLowerCase();
  const matches: AnchorEventJson[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wanted) {
      continue;
    }
    try {
      const decoded = decodeEventLog({ abi: ANCHOR_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "BatchAnchored") {
        continue;
      }
      matches.push({
        batchId: decoded.args.batchId,
        merkleRoot: decoded.args.merkleRoot,
        fromSeq: decoded.args.fromSeq.toString(10),
        toSeq: decoded.args.toSeq.toString(10),
        eventCount: Number(decoded.args.eventCount),
        treeFormat: decoded.args.treeFormat,
      });
    } catch {
      continue;
    }
  }
  return matches.find((item) => item.merkleRoot.toLowerCase() === expectedRoot.toLowerCase()) ?? matches[0] ?? null;
}

/**
 * Read-only. This function does not sign, broadcast, or submit a batch.
 */
export async function readAnchorObservation(input: {
  rpcUrl: string;
  chainId: SupportedChainId;
  contract: Address;
  txHash: Hex;
  expectedRoot: Hex;
}): Promise<AnchorObservationJson> {
  return withDeadline(readAnchorObservationInner(input), emptyObservation({ rpcError: "The read-only RPC did not respond in time." }));
}

async function readAnchorObservationInner(input: {
  rpcUrl: string;
  chainId: SupportedChainId;
  contract: Address;
  txHash: Hex;
  expectedRoot: Hex;
}): Promise<AnchorObservationJson> {
  const observation = emptyObservation();
  try {
    const client = publicClient(input.rpcUrl, input.chainId);
    try {
      observation.observedChainId = await client.getChainId();
    } catch (error) {
      observation.rpcError = publicRpcError(error, "chain id read failed");
      return observation;
    }
    try {
      observation.codeBytes = codeBytes(await client.getCode({ address: input.contract }));
    } catch (error) {
      observation.rpcError = publicRpcError(error, "code read failed");
      return observation;
    }
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await client.getTransactionReceipt({ hash: input.txHash });
    } catch (error) {
      const message = publicRpcError(error, "receipt read failed");
      if (/not found|could not be found/i.test(message)) {
        observation.receiptStatus = "missing";
        return observation;
      }
      observation.receiptError = message;
      return observation;
    }
    observation.receiptStatus = receipt.status === "success" ? "success" : "reverted";
    observation.receiptBlock = receipt.blockNumber.toString(10);
    if (receipt.status !== "success") {
      return observation;
    }
    observation.event = eventFromReceipt(receipt, input.contract, input.expectedRoot);
    if (!observation.event) {
      return observation;
    }
    try {
      const stored = await client.readContract({
        address: input.contract,
        abi: ANCHOR_ABI,
        functionName: "getBatch",
        args: [observation.event.batchId as Hex],
      });
      observation.storedBatch = {
        batchId: observation.event.batchId,
        merkleRoot: stored.merkleRoot,
        fromSeq: stored.fromSeq.toString(10),
        toSeq: stored.toSeq.toString(10),
        eventCount: Number(stored.eventCount),
        treeFormat: stored.treeFormat,
        anchoredAt: stored.anchoredAt.toString(10),
      };
    } catch (error) {
      observation.batchError = publicRpcError(error, "getBatch failed");
    }
    return observation;
  } catch (error) {
    observation.rpcError = publicRpcError(error, "RPC request failed");
    return observation;
  }
}

const HEX_32_ID = /^0x[0-9a-fA-F]{64}$/;

export type AnchorReadPlan =
  | { action: "none"; reason: string }
  | { action: "invalid"; reason: string }
  | {
      action: "ready";
      reason: string;
      chainId: SupportedChainId;
      contract: Address;
      txHash: Hex;
      root: Hex;
      blockNumber: string | null;
      rpcConfigured: boolean;
    };

/** Decides whether a recorded batch may be read. It never signs or broadcasts. */
export function planAnchorRead(input: {
  rpcConfigured: boolean;
  anchorStatus: string | null;
  chainId: number | null;
  contract: string | null;
  txHash: string | null;
  root: string | null;
  blockNumber: number | string | null;
}): AnchorReadPlan {
  const status = input.anchorStatus;
  if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
    return { action: "none", reason: "No onchain anchor is recorded." };
  }
  if (!input.txHash) {
    if (status === "failed") {
      return { action: "none", reason: "The recorded anchor status is failed and no transaction hash is stored." };
    }
    return { action: "invalid", reason: "An anchor is recorded without a transaction hash." };
  }
  if (input.chainId == null || (input.chainId !== 143 && input.chainId !== 10143)) {
    return { action: "invalid", reason: "The recorded anchor chain is not a supported Monad chain." };
  }
  if (!input.contract || !isAddress(input.contract)) {
    return { action: "invalid", reason: "The recorded anchor contract address is not valid." };
  }
  if (!HEX_32_ID.test(input.txHash)) {
    return { action: "invalid", reason: "The recorded anchor transaction hash is not valid." };
  }
  if (!input.root || !HEX_32_ID.test(input.root)) {
    return { action: "invalid", reason: "The batch root is not a 32-byte hash." };
  }
  let blockNumber: string | null = null;
  if (input.blockNumber != null && String(input.blockNumber) !== "") {
    const text = String(input.blockNumber);
    if (!/^[0-9]+$/.test(text)) {
      return { action: "invalid", reason: "The recorded anchor block is not a decimal number." };
    }
    blockNumber = text;
  }
  return {
    action: "ready",
    reason: input.rpcConfigured
      ? "Read-only chain id, bytecode, receipt, and getBatch."
      : "No read-only RPC is configured, so the contract was not queried.",
    chainId: input.chainId,
    contract: getAddress(input.contract),
    txHash: input.txHash.toLowerCase() as Hex,
    root: input.root.toLowerCase() as Hex,
    blockNumber,
    rpcConfigured: input.rpcConfigured,
  };
}

export async function readAddressCodes(
  rpcUrl: string,
  chainId: SupportedChainId,
  addresses: readonly string[],
): Promise<Record<string, number | null>> {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const unread: Record<string, number | null> = {};
  for (const address of unique) {
    unread[address] = null;
  }
  return withDeadline(readAddressCodesInner(rpcUrl, chainId, unique, unread), unread);
}

async function readAddressCodesInner(
  rpcUrl: string,
  chainId: SupportedChainId,
  unique: string[],
  out: Record<string, number | null>,
): Promise<Record<string, number | null>> {
  try {
    const client = publicClient(rpcUrl, chainId);
    const observed = await client.getChainId();
    if (observed !== chainId) {
      return out;
    }
    await Promise.all(
      unique.map(async (address) => {
        try {
          if (!isAddress(address)) {
            return;
          }
          out[address] = codeBytes(await client.getCode({ address }));
        } catch {
          out[address] = null;
        }
      }),
    );
  } catch {
    return out;
  }
  return out;
}

export function classifyCode(byteLength: number | null): "unread" | "no_code" | "has_code" {
  if (byteLength == null) {
    return "unread";
  }
  return byteLength === 0 ? "no_code" : "has_code";
}

export function codePresenceLabel(byteLength: number | null): string {
  const kind = classifyCode(byteLength);
  if (kind === "no_code") {
    return "Predicted and undeployed. No bytecode was found at this address.";
  }
  if (kind === "has_code") {
    return "Bytecode is present. This page does not treat that as a chogOS deployment or as proof of an anchored batch.";
  }
  return "Code was not read. Treat this address as predicted, not as a deployed contract.";
}
