import { publicRpcError } from "@/lib/verify/anchor";

const HASH = /^0x[0-9a-fA-F]{64}$/i;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const READ_METHODS = new Set(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
const RPC_TIMEOUT_MS = 4_000;

/**
 * Runtime brand applied only inside verifyMainnetReceipt.
 * A TypeScript cast or a caller-built object does not carry it.
 */
const rpcVerifiedBrand: unique symbol = Symbol("chogos.rpc-verified-mainnet-receipt");

export type RpcCaller = (method: string, params: unknown[]) => Promise<unknown>;

export type RpcVerifiedReceipt = {
  readonly [rpcVerifiedBrand]: true;
  readonly source: "monad-mainnet-rpc";
  readonly chainId: 143;
  readonly txHash: `0x${string}`;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
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
    row.blockNumber >= 0n
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

  const sealed = {
    source: "monad-mainnet-rpc" as const,
    chainId: 143 as const,
    txHash,
    status,
    blockNumber,
    blockHash,
  };
  Object.defineProperty(sealed, rpcVerifiedBrand, { value: true });
  return { ok: true, receipt: sealed as RpcVerifiedReceipt };
}

/** POST JSON-RPC for the three read methods. An unset URL fails closed and is not a verification. */
export function jsonRpcCaller(rpcUrl: string | undefined, timeoutMs = RPC_TIMEOUT_MS): RpcCaller {
  return async (method, params) => {
    if (!READ_METHODS.has(method)) {
      throw new Error("That RPC method is not part of the read-only receipt check.");
    }
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
