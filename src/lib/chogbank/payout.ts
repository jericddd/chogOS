import {
  concat,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import {
  CHAIN_AUTHORIZATION_TTL,
  CHAIN_CHOG_CAP,
  CHAIN_MON_AGGREGATE,
  CHAIN_MON_CITIZEN,
  CHAIN_MON_PER_TX,
  CHAIN_WINDOW_SECONDS,
  MAINNET_CHOG_BANK,
  MAINNET_CHOG_BANK_AUTHORIZER,
  MAINNET_PAYOUT_GAS,
  PAYOUT_DEADLINE_SECONDS,
  PAYOUT_GAS_RESERVE_WEI,
} from "@/lib/chogbank/bank";
import { lowestIssuerFees } from "@/lib/wallets/issuer";
import { treasuryDecisionId, treasuryReasonHash, type TreasuryAsset } from "@/lib/economy/treasury-policy";
import { economicPayoutReason } from "@/lib/chogbank/payout-reason";

export const DEFAULT_PAYOUT_URL = "https://chogos.vercel.app/api/economy/payouts";
export { PAYOUT_GAS_RESERVE_WEI };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^[0-9]+$/;

export const ALLOCATION_TYPES = {
  Allocation: [
    { name: "decisionId", type: "bytes32" },
    { name: "tokenId", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "reasonHash", type: "bytes32" },
  ],
} as const;

const distributedEventDef = {
  type: "event",
  name: "Distributed",
  inputs: [
    { name: "decisionId", type: "bytes32", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "deadline", type: "uint256", indexed: false },
    { name: "reasonHash", type: "bytes32", indexed: false },
  ],
} as const;

export const distributedEvent = distributedEventDef;

export const bankAbi = [
  { type: "function", name: "authorizer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "configuredChainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "genesis", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "chogToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "windowSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAuthorizationTtl", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxPerTxMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxCitizenWindowMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAggregateWindowMon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxPerTxChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxCitizenWindowChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAggregateWindowChog", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "usedDecision",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "spentByCitizen",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "spentInWindow",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "payoutRecipient",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "decisionId", type: "bytes32" },
      { name: "tokenId", type: "uint256" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "reasonHash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  distributedEventDef,
] as const;

export type PendingPayout = {
  decisionId: Hex;
  tokenId: string;
  asset: TreasuryAsset;
  amountRaw: string;
  reason: string;
  windowId: string;
};

export type PayoutResult = { paid: number; observed: number; skipped: number; failed: number };

export type ChainLog = { address: Address; data: Hex; topics: readonly unknown[] };

export type DistributedPayment = {
  decisionId: Hex;
  tokenId: bigint;
  recipient: Address;
  asset: Address;
  amount: bigint;
  deadline: bigint;
  reasonHash: Hex;
};

export type AllocationMessage = {
  decisionId: Hex;
  tokenId: bigint;
  asset: Address;
  amount: bigint;
  deadline: bigint;
  reasonHash: Hex;
};

export type BankSnapshot = {
  authorizer: Address;
  chainId: bigint;
  genesis: Address;
  chogToken: Address;
  windowSeconds: bigint;
  maxAuthorizationTtl: bigint;
  maxPerTxMon: bigint;
  maxCitizenWindowMon: bigint;
  maxAggregateWindowMon: bigint;
  maxPerTxChog: bigint;
  maxCitizenWindowChog: bigint;
  maxAggregateWindowChog: bigint;
  monBalance: bigint;
  chogBalance: bigint;
};

export type PayoutIO = {
  bank: Address;
  authorizer: Address;
  gas: Address;
  monDistributed: boolean;
  chainId: () => Promise<number>;
  snapshot: () => Promise<BankSnapshot>;
  now: () => Promise<bigint>;
  baseFee: () => Promise<bigint>;
  usedDecision: (decisionId: Hex) => Promise<boolean>;
  spent: (asset: Address, windowId: bigint, tokenId: bigint) => Promise<{ citizen: bigint; window: bigint }>;
  recipient: (tokenId: bigint) => Promise<Address>;
  existing: (decisionId: Hex) => Promise<{ txHash: Hex; log: DistributedPayment } | null>;
  gasBalance: () => Promise<bigint>;
  sign: (message: AllocationMessage) => Promise<Hex>;
  send: (input: AllocationMessage & { signature: Hex; maxFeePerGas: bigint; maxPriorityFeePerGas: 1n }) => Promise<Hex>;
  receipt: (hash: Hex) => Promise<{ status: "success" | "reverted"; logs: readonly ChainLog[] }>;
  confirm: (body: { decisionId: Hex; txHash: Hex }) => Promise<{ ok: true } | { ok: false; error: string }>;
  log: (line: string) => void;
};

export function chogBankDomain(bank: Address) {
  return {
    name: "chogOS ChogBank",
    version: "1",
    chainId: 143,
    verifyingContract: bank,
  } as const;
}

/** The digest ChogBank.allocationDigest recovers. It matches viem's EIP-712 hash. */
export function allocationDigest(bank: Address, message: AllocationMessage): Hex {
  const domainType = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainType, keccak256(toBytes("chogOS ChogBank")), keccak256(toBytes("1")), 143n, bank],
    ),
  );
  const typeHash = keccak256(
    toBytes("Allocation(bytes32 decisionId,uint256 tokenId,address asset,uint256 amount,uint256 deadline,bytes32 reasonHash)"),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [typeHash, message.decisionId, message.tokenId, message.asset, message.amount, message.deadline, message.reasonHash],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

export function viemAllocationDigest(bank: Address, message: AllocationMessage): Hex {
  return hashTypedData({
    domain: chogBankDomain(bank),
    types: ALLOCATION_TYPES,
    primaryType: "Allocation",
    message,
  });
}

export function assetAddress(asset: TreasuryAsset): Address {
  return asset === "MON" ? zeroAddress : addresses.chogToken;
}

export function payoutEndpoint(runnerUrl: string | undefined): string {
  if (!runnerUrl?.trim()) return DEFAULT_PAYOUT_URL;
  let url: URL;
  try {
    url = new URL(runnerUrl.trim());
  } catch {
    return DEFAULT_PAYOUT_URL;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return DEFAULT_PAYOUT_URL;
  url.pathname = "/api/economy/payouts";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function payoutDeadline(now: bigint, ttl: bigint): bigint {
  if (ttl < PAYOUT_DEADLINE_SECONDS) throw new Error("The authorization window is shorter than this payout deadline.");
  const deadline = now + PAYOUT_DEADLINE_SECONDS;
  if (deadline <= now || deadline > now + ttl) throw new Error("The payout deadline is outside the contract window.");
  return deadline;
}

export function spendKeys(asset: Address, windowId: bigint, tokenId: bigint): { citizen: Hex; window: Hex } {
  return {
    window: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [asset, windowId])),
    citizen: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [asset, windowId, tokenId])),
  };
}

export function payoutReason(output: Record<string, unknown>, rationale: string | null): string | null {
  const stored = economicPayoutReason(output.reason);
  if (stored) return stored;
  const raw = rationale?.trim() ?? "";
  if (!raw || raw.length > 320 || /https?:\/\//i.test(raw)) return null;
  if (economicPayoutReason(raw) == null) return null;
  return raw;
}

export function pendingPayoutFromOutput(output: Record<string, unknown>): PendingPayout | null {
  if (output.onchain === true || output.verified === true) return null;
  if (typeof output.txHash === "string" && HASH.test(output.txHash)) return null;
  const tokenId = typeof output.tokenId === "string" || typeof output.tokenId === "number" ? String(output.tokenId).split(".")[0] : "";
  const asset = output.asset === "MON" || output.asset === "CHOG" ? output.asset : null;
  const amountRaw = typeof output.amountRaw === "string" ? output.amountRaw : "";
  const windowId = typeof output.windowId === "string" ? output.windowId : "";
  const decisionId = typeof output.decisionId === "string" ? output.decisionId.toLowerCase() : "";
  const reason = economicPayoutReason(output.reason);
  if (!asset || !reason || !DECIMAL.test(tokenId) || !DECIMAL.test(amountRaw) || !DECIMAL.test(windowId) || !HASH.test(decisionId)) {
    return null;
  }
  if (BigInt(amountRaw) <= 0n) return null;
  if (treasuryDecisionId(tokenId, asset, windowId).toLowerCase() !== decisionId) return null;
  return { decisionId: decisionId as Hex, tokenId, asset, amountRaw, reason, windowId };
}

export function bankSnapshotProblem(snapshot: BankSnapshot): string | null {
  if (getAddress(snapshot.authorizer) !== MAINNET_CHOG_BANK_AUTHORIZER) return "The on-chain authorizer does not match the pinned authorizer.";
  if (snapshot.chainId !== 143n) return "ChogBank is not configured for chain 143.";
  if (getAddress(snapshot.genesis) !== addresses.chogGenesis) return "ChogBank genesis does not match the official collection.";
  if (getAddress(snapshot.chogToken) !== addresses.chogToken) return "ChogBank token does not match official $CHOG.";
  if (snapshot.windowSeconds !== CHAIN_WINDOW_SECONDS || snapshot.maxAuthorizationTtl !== CHAIN_AUTHORIZATION_TTL) {
    return "ChogBank window does not match the deployed payout limits.";
  }
  if (
    snapshot.maxPerTxMon !== CHAIN_MON_PER_TX ||
    snapshot.maxCitizenWindowMon !== CHAIN_MON_CITIZEN ||
    snapshot.maxAggregateWindowMon !== CHAIN_MON_AGGREGATE ||
    snapshot.maxPerTxChog !== CHAIN_CHOG_CAP ||
    snapshot.maxCitizenWindowChog !== CHAIN_CHOG_CAP ||
    snapshot.maxAggregateWindowChog !== CHAIN_CHOG_CAP
  ) {
    return "ChogBank caps do not match the deployed payout limits.";
  }
  return null;
}

export function payableAmount(input: {
  requested: bigint;
  perTx: bigint;
  citizenSpent: bigint;
  citizenCap: bigint;
  windowSpent: bigint;
  windowCap: bigint;
  balance: bigint;
}): bigint | null {
  if (input.requested <= 0n || input.perTx <= 0n || input.balance <= 0n) return null;
  const citizenRoom = input.citizenSpent >= input.citizenCap ? 0n : input.citizenCap - input.citizenSpent;
  const windowRoom = input.windowSpent >= input.windowCap ? 0n : input.windowCap - input.windowSpent;
  let amount = input.requested;
  if (amount > input.perTx) amount = input.perTx;
  if (amount > citizenRoom) amount = citizenRoom;
  if (amount > windowRoom) amount = windowRoom;
  if (amount > input.balance) amount = input.balance;
  return amount > 0n ? amount : null;
}

export function matchDistributed(
  logs: readonly ChainLog[],
  expected: { bank: Address; decisionId: Hex },
): DistributedPayment | null {
  const bank = expected.bank.toLowerCase();
  const decisionId = expected.decisionId.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== bank) continue;
    try {
      const decoded = decodeEventLog({ abi: bankAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName !== "Distributed") continue;
      if (decoded.args.decisionId.toLowerCase() !== decisionId) continue;
      return {
        decisionId: decoded.args.decisionId,
        tokenId: decoded.args.tokenId,
        recipient: getAddress(decoded.args.recipient),
        asset: getAddress(decoded.args.asset),
        amount: decoded.args.amount,
        deadline: decoded.args.deadline,
        reasonHash: decoded.args.reasonHash,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function acceptedPayout(input: {
  stored: { decisionId: Hex; tokenId: string; asset: TreasuryAsset; amountRaw: bigint; reason: string };
  log: DistributedPayment;
  recipient: Address;
}): { ok: true; amount: bigint } | { ok: false; reason: string } {
  if (input.log.decisionId.toLowerCase() !== input.stored.decisionId.toLowerCase()) {
    return { ok: false, reason: "The receipt is for a different decision." };
  }
  if (input.log.tokenId !== BigInt(input.stored.tokenId)) {
    return { ok: false, reason: "The receipt token does not match this citizen." };
  }
  if (input.log.asset.toLowerCase() !== assetAddress(input.stored.asset).toLowerCase()) {
    return { ok: false, reason: "The receipt asset does not match this decision." };
  }
  if (getAddress(input.log.recipient) !== getAddress(input.recipient)) {
    return { ok: false, reason: "The receipt recipient is not this citizen wallet." };
  }
  const perTx = input.stored.asset === "MON" ? CHAIN_MON_PER_TX : CHAIN_CHOG_CAP;
  if (input.log.amount <= 0n || input.log.amount > perTx || input.log.amount > input.stored.amountRaw) {
    return { ok: false, reason: "The receipt amount is outside the stored decision and the contract cap." };
  }
  if (input.log.reasonHash.toLowerCase() !== treasuryReasonHash(input.stored.reason).toLowerCase()) {
    return { ok: false, reason: "The receipt reason does not match the stored decision." };
  }
  return { ok: true, amount: input.log.amount };
}

export function parsePayoutList(body: unknown): { bank: Address; monDistributed: boolean; decisions: PendingPayout[] } {
  if (!body || typeof body !== "object") throw new Error("The payout list was empty.");
  const record = body as Record<string, unknown>;
  if (record.ok !== true) throw new Error(typeof record.error === "string" ? record.error : "The payout list was refused.");
  if (typeof record.bank !== "string" || !isAddress(record.bank)) throw new Error("The payout list did not include ChogBank.");
  if (getAddress(record.bank) !== MAINNET_CHOG_BANK) throw new Error("The payout API bank does not match the pinned ChogBank.");
  if (!Array.isArray(record.decisions)) throw new Error("The payout list did not include decisions.");
  const decisions: PendingPayout[] = [];
  for (const item of record.decisions) {
    if (!item || typeof item !== "object") throw new Error("A listed payout was not an object.");
    const row = item as Record<string, unknown>;
    const pending = pendingPayoutFromOutput(row);
    if (!pending) throw new Error(`Refusing a listed payout for token ${typeof row.tokenId === "string" ? row.tokenId : "unknown"}.`);
    decisions.push(pending);
  }
  return { bank: MAINNET_CHOG_BANK, monDistributed: record.monDistributed === true, decisions };
}

/** One named allocation. Any other list is refused before a signature. */
export function selectManualPayout(decisions: readonly PendingPayout[], decisionId: Hex): PendingPayout {
  if (decisions.length !== 1) {
    throw new Error("The payout list did not contain exactly one decision. Nothing was signed.");
  }
  const only = decisions[0];
  if (!only || only.decisionId.toLowerCase() !== decisionId.toLowerCase()) {
    throw new Error("The payout list was for a different decision. Nothing was signed.");
  }
  if (!economicPayoutReason(only.reason)) {
    throw new Error("The stored world reason cannot be paid. Nothing was signed.");
  }
  return only;
}

/**
 * Broadcast accepted allocations with ChogBank.distribute.
 * The authorizer signs. The gas wallet pays gas. No other contract call is made.
 * $CHOG waits until a confirmed MON distribution exists.
 */
export async function broadcastPendingPayouts(decisions: readonly PendingPayout[], io: PayoutIO): Promise<PayoutResult> {
  if (getAddress(io.bank) !== MAINNET_CHOG_BANK) throw new Error("The payout bank is not the pinned ChogBank. Nothing was signed.");
  if (getAddress(io.authorizer) !== MAINNET_CHOG_BANK_AUTHORIZER) {
    throw new Error("The authorizer key does not match the ChogBank authorizer. Nothing was signed.");
  }
  if (getAddress(io.gas) !== MAINNET_PAYOUT_GAS) throw new Error("The gas key does not match the payout gas wallet. Nothing was signed.");
  if (getAddress(io.authorizer) === getAddress(io.gas)) throw new Error("The authorizer and the gas wallet are the same. Nothing was signed.");
  const chainId = await io.chainId();
  if (chainId !== 143) throw new Error(`Payouts stopped because the RPC chain is ${chainId}. Nothing was signed.`);
  const snapshot = await io.snapshot();
  const problem = bankSnapshotProblem(snapshot);
  if (problem) throw new Error(`${problem} Nothing was signed.`);
  const ordered = [...decisions].sort((left, right) => (left.asset === right.asset ? 0 : left.asset === "MON" ? -1 : 1));
  let paid = 0;
  let observed = 0;
  let skipped = 0;
  let failed = 0;
  let monDistributed = io.monDistributed;
  let monBalance = snapshot.monBalance;
  let chogBalance = snapshot.chogBalance;
  for (const decision of ordered) {
    try {
      if (treasuryDecisionId(decision.tokenId, decision.asset, decision.windowId).toLowerCase() !== decision.decisionId.toLowerCase()) {
        io.log(`Token ${decision.tokenId} decision id does not belong to that allocation. Nothing was signed.`);
        skipped += 1;
        continue;
      }
      if (decision.asset === "CHOG" && !monDistributed) {
        io.log(`Token ${decision.tokenId} $CHOG allocation is waiting for a confirmed MON distribution.`);
        skipped += 1;
        continue;
      }
      const now = await io.now();
      const windowId = now / snapshot.windowSeconds;
      if (BigInt(decision.windowId) !== windowId) {
        io.log(`Token ${decision.tokenId} allocation is for window ${decision.windowId}. The current window is ${windowId}. Nothing was signed.`);
        skipped += 1;
        continue;
      }
      const tokenId = BigInt(decision.tokenId);
      const asset = assetAddress(decision.asset);
      const requested = BigInt(decision.amountRaw);
      let recipient: Address;
      try {
        recipient = await io.recipient(tokenId);
      } catch {
        io.log(`Token ${decision.tokenId} has no deployed citizen wallet. Nothing was signed.`);
        skipped += 1;
        continue;
      }
      if (await io.usedDecision(decision.decisionId)) {
        const found = await io.existing(decision.decisionId);
        const accepted = found
          ? acceptedPayout({
              stored: { ...decision, amountRaw: requested },
              log: found.log,
              recipient,
            })
          : null;
        if (!found || !accepted || !accepted.ok) {
          io.log(`Token ${decision.tokenId} decision is already used and no matching receipt was found. Nothing was signed.`);
          skipped += 1;
          continue;
        }
        const saved = await io.confirm({ decisionId: decision.decisionId, txHash: found.txHash });
        if (!saved.ok) throw new Error(saved.error);
        io.log(`Token ${decision.tokenId} payout ${found.txHash} was already on Monad. The receipt is linked.`);
        if (decision.asset === "MON") monDistributed = true;
        observed += 1;
        continue;
      }
      const spent = await io.spent(asset, windowId, tokenId);
      const balance = decision.asset === "MON" ? monBalance : chogBalance;
      const perTx = decision.asset === "MON" ? snapshot.maxPerTxMon : snapshot.maxPerTxChog;
      const citizenCap = decision.asset === "MON" ? snapshot.maxCitizenWindowMon : snapshot.maxCitizenWindowChog;
      const windowCap = decision.asset === "MON" ? snapshot.maxAggregateWindowMon : snapshot.maxAggregateWindowChog;
      const amount = payableAmount({
        requested,
        perTx,
        citizenSpent: spent.citizen,
        citizenCap,
        windowSpent: spent.window,
        windowCap,
        balance,
      });
      if (amount == null) {
        io.log(`Token ${decision.tokenId} allocation does not fit the remaining cap or balance. Nothing was signed.`);
        skipped += 1;
        continue;
      }
      const gasBalance = await io.gasBalance();
      if (gasBalance < PAYOUT_GAS_RESERVE_WEI) {
        throw new Error(`Gas wallet ${MAINNET_PAYOUT_GAS} has ${gasBalance} wei, short of ${PAYOUT_GAS_RESERVE_WEI} wei. Nothing further was signed.`);
      }
      const deadline = payoutDeadline(now, snapshot.maxAuthorizationTtl);
      const message: AllocationMessage = {
        decisionId: decision.decisionId,
        tokenId,
        asset,
        amount,
        deadline,
        reasonHash: treasuryReasonHash(decision.reason),
      };
      const signature = await io.sign(message);
      const fees = lowestIssuerFees(await io.baseFee());
      const hash = await io.send({ ...message, signature, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      const mined = await io.receipt(hash);
      if (mined.status !== "success") throw new Error(`Token ${decision.tokenId} transaction ${hash} reverted.`);
      const log = matchDistributed(mined.logs, { bank: io.bank, decisionId: decision.decisionId });
      const accepted = log ? acceptedPayout({ stored: { ...decision, amountRaw: requested }, log, recipient }) : null;
      if (!log || !accepted || !accepted.ok || accepted.amount !== amount) {
        throw new Error(`Token ${decision.tokenId} transaction ${hash} did not match this allocation.`);
      }
      const saved = await io.confirm({ decisionId: decision.decisionId, txHash: hash });
      if (!saved.ok) throw new Error(saved.error);
      io.log(`Token ${decision.tokenId} received ${amount} base units in ${hash}.`);
      if (decision.asset === "MON") {
        monDistributed = true;
        monBalance -= amount;
      } else {
        chogBalance -= amount;
      }
      paid += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "ChogBank payout failed.";
      io.log(message.slice(0, 500));
      break;
    }
  }
  return { paid, observed, skipped, failed };
}
