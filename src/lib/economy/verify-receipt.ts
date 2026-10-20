import { getAddress } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { publicRpcError } from "@/lib/verify/anchor";

const HASH = /^0x[0-9a-fA-F]{64}$/i;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/i;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/i;
/** keccak256("Transfer(address,address,uint256)"). Kept here so log queries cannot import a second topic. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_LOG_BLOCKS = 100n;
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getLogs",
]);
const RPC_TIMEOUT_MS = 4_000;

/**
 * Runtime brand applied only inside verifyMainnetReceipt.
 * A TypeScript cast or a caller-built object does not carry it.
 */
const rpcVerifiedBrand: unique symbol = Symbol("chogos.rpc-verified-mainnet-receipt");

export type RpcCaller = (method: string, params: unknown[]) => Promise<unknown>;

export type RpcReceiptLog = {
  readonly index: number;
  readonly address: `0x${string}`;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
};

export type RpcVerifiedReceipt = {
  readonly [rpcVerifiedBrand]: true;
  readonly source: "monad-mainnet-rpc";
  readonly chainId: 143;
  readonly txHash: `0x${string}`;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  /** True only when this receipt object included a logs array. An empty array was read. */
  readonly logsRead: boolean;
  readonly logs: readonly RpcReceiptLog[];
};

export type ReceiptVerifyFailure = "malformed" | "wrong_chain" | "missing" | "mismatch" | "rpc_failure";

export type ReceiptVerifyResult =
  | { ok: true; receipt: RpcVerifiedReceipt }
  | { ok: false; outcome: ReceiptVerifyFailure; reason: string };

export function isRpcVerifiedReceipt(value: unknown): value is RpcVerifiedReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as RpcVerifiedReceipt;
  return (
    row[rpcVerifiedBrand] === true &&
    row.source === "monad-mainnet-rpc" &&
    row.chainId === 143 &&
    (row.status === "success" || row.status === "reverted") &&
    typeof row.txHash === "string" &&
    HASH.test(row.txHash) &&
    row.txHash === row.txHash.toLowerCase() &&
    typeof row.blockHash === "string" &&
    HASH.test(row.blockHash) &&
    row.blockHash === row.blockHash.toLowerCase() &&
    typeof row.blockNumber === "bigint" &&
    row.blockNumber >= 0n &&
    (row.logsRead === true || row.logsRead === false) &&
    Array.isArray(row.logs)
  );
}

/**
 * Read-only JSON-RPC check against Monad mainnet.
 * Caller-supplied receipt fields are not evidence. This function does not sign or broadcast.
 */
export async function verifyMainnetReceipt(input: {
  txHash: string;
  call: RpcCaller;
  timeoutMs?: number;
}): Promise<ReceiptVerifyResult> {
  if (!HASH.test(input.txHash)) {
    return { ok: false, outcome: "malformed", reason: "The transaction hash is malformed." };
  }
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const txHash = input.txHash.toLowerCase() as `0x${string}`;

  let chainRaw: unknown;
  try {
    chainRaw = await rpcCall(input.call, "eth_chainId", [], timeoutMs);
  } catch (error) {
    return failRpc(error);
  }
  const chainId = parseQuantity(chainRaw);
  if (chainId === null) {
    return { ok: false, outcome: "malformed", reason: "The chain id response was malformed." };
  }
  if (chainId !== 143n) {
    return { ok: false, outcome: "wrong_chain", reason: "Receipt evidence must be observed on Monad mainnet 143." };
  }

  let receiptRaw: unknown;
  try {
    receiptRaw = await rpcCall(input.call, "eth_getTransactionReceipt", [txHash], timeoutMs);
  } catch (error) {
    return failRpc(error);
  }
  if (receiptRaw === null) {
    return { ok: false, outcome: "missing", reason: "The mainnet receipt was not found." };
  }
  const receipt = record(receiptRaw);
  if (!receipt) {
    return { ok: false, outcome: "malformed", reason: "The receipt response was malformed." };
  }
  const receiptHash = hashOf(receipt.transactionHash);
  if (!receiptHash || receiptHash !== txHash) {
    return { ok: false, outcome: "mismatch", reason: "The receipt transaction hash does not match the requested transaction." };
  }
  const status = receiptStatus(receipt.status);
  const blockNumber = parseQuantity(receipt.blockNumber);
  const blockHash = hashOf(receipt.blockHash);
  if (!status || blockNumber === null || blockNumber < 0n || !blockHash) {
    return { ok: false, outcome: "malformed", reason: "The receipt is missing a status, block number, or block hash." };
  }

  let blockRaw: unknown;
  try {
    blockRaw = await rpcCall(input.call, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false], timeoutMs);
  } catch (error) {
    return failRpc(error);
  }
  if (blockRaw === null) {
    return { ok: false, outcome: "mismatch", reason: "The block hash does not correspond to the receipt's block." };
  }
  const block = record(blockRaw);
  const returnedNumber = block ? parseQuantity(block.number) : null;
  const returnedHash = block ? hashOf(block.hash) : null;
  if (!block || returnedNumber === null || !returnedHash || returnedNumber !== blockNumber || returnedHash !== blockHash) {
    return { ok: false, outcome: "mismatch", reason: "The block hash does not correspond to the receipt's block." };
  }

  const logs = parseReceiptLogs(receipt.logs, txHash, blockHash);
  if (!logs.ok) {
    return { ok: false, outcome: "malformed", reason: logs.reason };
  }

  const sealed = {
    source: "monad-mainnet-rpc" as const,
    chainId: 143 as const,
    txHash,
    status,
    blockNumber,
    blockHash,
    logsRead: logs.logsRead,
    logs: logs.logs,
  };
  Object.defineProperty(sealed, rpcVerifiedBrand, { value: true });
  return { ok: true, receipt: Object.freeze(sealed) as RpcVerifiedReceipt };
}

/**
 * POST JSON-RPC for receipt verification and bounded $CHOG log discovery.
 * An unset URL fails closed and is not a verification. eth_getLogs is pinned to the
 * configured token, the Transfer topic, and a 100-block span.
 */
export function jsonRpcCaller(rpcUrl: string | undefined, timeoutMs = RPC_TIMEOUT_MS): RpcCaller {
  return async (method, params) => {
    if (!READ_METHODS.has(method)) {
      throw new Error("That RPC method is not part of the read-only receipt check.");
    }
    assertReadParams(method, params);
    if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) {
      throw new Error("Monad mainnet RPC is not configured.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`RPC request failed (${response.status}).`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("RPC response was malformed.");
      }
      const row = record(body);
      if (!row || row.jsonrpc !== "2.0" || !("result" in row)) {
        throw new Error("RPC response was malformed.");
      }
      if (row.error != null) {
        const message =
          row.error && typeof row.error === "object" && "message" in row.error
            ? String((row.error as { message: unknown }).message)
            : "RPC request failed.";
        throw new Error(message);
      }
      return row.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

function assertReadParams(method: string, params: unknown[]): void {
  if (method === "eth_chainId" || method === "eth_blockNumber") {
    if (params.length !== 0) {
      throw new Error("The read-only RPC parameters were rejected.");
    }
    return;
  }
  if (method === "eth_getTransactionReceipt") {
    if (params.length !== 1 || typeof params[0] !== "string" || !HASH.test(params[0])) {
      throw new Error("The read-only RPC parameters were rejected.");
    }
    return;
  }
  if (method === "eth_getBlockByNumber") {
    if (params.length !== 2 || typeof params[0] !== "string" || !QUANTITY.test(params[0]) || params[1] !== false) {
      throw new Error("The read-only RPC parameters were rejected.");
    }
    return;
  }
  if (method === "eth_getLogs") {
    assertLogQuery(params);
    return;
  }
  throw new Error("That RPC method is not part of the read-only receipt check.");
}

function assertLogQuery(params: unknown[]): void {
  if (params.length !== 1 || !params[0] || typeof params[0] !== "object" || Array.isArray(params[0])) {
    throw new Error("The read-only RPC parameters were rejected.");
  }
  const filter = params[0] as Record<string, unknown>;
  const allowed = new Set(["address", "fromBlock", "toBlock", "topics"]);
  const keys = Object.keys(filter);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new Error("The read-only RPC parameters were rejected.");
  }
  let token: string;
  try {
    token = getAddress(typeof filter.address === "string" ? filter.address : "");
  } catch {
    throw new Error("The read-only RPC parameters were rejected.");
  }
  if (token !== addresses.chogToken) {
    throw new Error("The read-only RPC parameters were rejected.");
  }
  if (
    !Array.isArray(filter.topics) ||
    filter.topics.length !== 1 ||
    typeof filter.topics[0] !== "string" ||
    filter.topics[0].toLowerCase() !== TRANSFER_TOPIC
  ) {
    throw new Error("The read-only RPC parameters were rejected.");
  }
  const from = parseQuantity(filter.fromBlock);
  const to = parseQuantity(filter.toBlock);
  if (from === null || to === null || from < 0n || to < from || to - from + 1n > MAX_LOG_BLOCKS) {
    throw new Error("The read-only RPC parameters were rejected.");
  }
}

function failRpc(error: unknown): ReceiptVerifyResult {
  return { ok: false, outcome: "rpc_failure", reason: publicRpcError(error, "The read-only RPC failed.") };
}

async function rpcCall(call: RpcCaller, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(method, params)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The read-only RPC did not respond in time.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hashOf(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !HASH.test(value)) {
    return null;
  }
  return value.toLowerCase() as `0x${string}`;
}

function receiptStatus(value: unknown): "success" | "reverted" | null {
  const parsed = parseQuantity(value);
  if (parsed === 1n) {
    return "success";
  }
  if (parsed === 0n) {
    return "reverted";
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Logs are optional for callers that predate this field. When the field is present
 * it must be a consistent array from the same receipt. A removed log, a repeated
 * index, or a hash that disagrees with the receipt fails the whole check.
 */
function parseReceiptLogs(
  value: unknown,
  txHash: `0x${string}`,
  blockHash: `0x${string}`,
): { ok: true; logsRead: boolean; logs: readonly RpcReceiptLog[] } | { ok: false; reason: string } {
  if (value === undefined) {
    return { ok: true, logsRead: false, logs: Object.freeze([]) };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: "The receipt logs were malformed." };
  }
  const logs: RpcReceiptLog[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const row = record(item);
    if (!row || row.removed === true) {
      return { ok: false, reason: "The receipt logs were malformed." };
    }
    const index = parseQuantity(row.logIndex);
    const address = addressOf(row.address);
    const topics = topicsOf(row.topics);
    const data = dataOf(row.data);
    if (index === null || index < 0n || index > BigInt(Number.MAX_SAFE_INTEGER) || !address || !topics || data === null) {
      return { ok: false, reason: "The receipt logs were malformed." };
    }
    const logIndex = Number(index);
    if (seen.has(logIndex)) {
      return { ok: false, reason: "The receipt logs were malformed." };
    }
    seen.add(logIndex);
    const logTx = row.transactionHash === undefined ? txHash : hashOf(row.transactionHash);
    const logBlock = row.blockHash === undefined ? blockHash : hashOf(row.blockHash);
    if (logTx !== txHash || logBlock !== blockHash) {
      return { ok: false, reason: "The receipt logs were malformed." };
    }
    logs.push(Object.freeze({ index: logIndex, address, topics, data }));
  }
  return { ok: true, logsRead: true, logs: Object.freeze(logs) };
}

function addressOf(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    return null;
  }
  return value.toLowerCase() as `0x${string}`;
}

function topicsOf(value: unknown): readonly `0x${string}`[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const topics: `0x${string}`[] = [];
  for (const topic of value) {
    const hash = hashOf(topic);
    if (!hash) {
      return null;
    }
    topics.push(hash);
  }
  return Object.freeze(topics);
}

function dataOf(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !DATA.test(value)) {
    return null;
  }
  return value.toLowerCase() as `0x${string}`;
}
