import { readdirSync, readFileSync } from "node:fs";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as getReceipt } from "@/app/api/economy/receipt/route";
import { POST as postTransaction } from "@/app/api/transactions/route";
import { addresses } from "@/lib/blockchain/addresses";
import { CHOG_TRANSFER_EVENT, CHOG_TRANSFER_TOPIC, decodeChogTransfers } from "@/lib/economy/decode-transfer";
import { treasuryPosition, type JournalLine } from "@/lib/economy/journal";
import { interpretLedgerSnapshot } from "@/lib/economy/ledger";
import { productionExecutionStatus } from "@/lib/economy/execution";
import {
  PUBLIC_RECEIPT_LIMIT,
  receiptDiscrepancy,
  recheckRecordedReceipts,
  resetPublicVerificationState,
  type RecordedEvidence,
} from "@/lib/economy/public-verification";
import { verifyMainnetReceipt, type RpcCaller } from "@/lib/economy/verify-receipt";

const TX = `0x${"ab".repeat(32)}` as Hex;
const OTHER_TX = `0x${"ef".repeat(32)}` as Hex;
const BLOCK = `0x${"cd".repeat(32)}` as Hex;
const OTHER_BLOCK = `0x${"12".repeat(32)}` as Hex;
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const SENDER = getAddress("0x2222222222222222222222222222222222222222");
const RECIPIENT = getAddress("0x3333333333333333333333333333333333333333");
const AMOUNT = 10n;

function mainnet(options: {
  chain?: unknown;
  receipt?: unknown;
  block?: unknown;
  throwOn?: string;
  hangOn?: string;
} = {}): { call: RpcCaller; methods: string[] } {
  const methods: string[] = [];
  const call: RpcCaller = (method, params) => {
    methods.push(method);
    if (options.throwOn === method) {
      return Promise.reject(new Error("connect failed https://rpc.example/secret?token=abc"));
    }
    if (options.hangOn === method) {
      return new Promise(() => undefined);
    }
    if (method === "eth_chainId") {
      return Promise.resolve(options.chain === undefined ? "0x8f" : options.chain);
    }
    if (method === "eth_getTransactionReceipt") {
      return Promise.resolve(
        options.receipt === undefined
          ? { transactionHash: params[0], status: "0x1", blockNumber: "0xa", blockHash: BLOCK, logs: [] }
          : options.receipt,
      );
    }
    if (method === "eth_getBlockByNumber") {
      return Promise.resolve(options.block === undefined ? { number: "0xa", hash: BLOCK } : options.block);
    }
    return Promise.reject(new Error(method));
  };
  return { call, methods };
}

function topicAddress(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}` as Hex;
}

function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function transferLog(input: {
  index?: number;
  token?: Address;
  from?: Address;
  to?: Address;
  amount?: bigint;
  data?: string;
  topics?: string[];
  removed?: boolean;
  transactionHash?: string;
  blockHash?: string;
}) {
  const index = input.index ?? 0;
  return {
    logIndex: `0x${index.toString(16)}`,
    address: input.token ?? addresses.chogToken,
    topics: input.topics ?? [CHOG_TRANSFER_TOPIC, topicAddress(input.from ?? SENDER), topicAddress(input.to ?? TREASURY)],
    data: input.data ?? word(input.amount ?? AMOUNT),
    removed: input.removed,
    transactionHash: input.transactionHash ?? TX,
    blockHash: input.blockHash ?? BLOCK,
  };
}

function receipt(logs: unknown[], status: "0x1" | "0x0" = "0x1", tx: Hex = TX) {
  return { transactionHash: tx, status, blockNumber: "0xa", blockHash: BLOCK, logs };
}

function recorded(tx: string = TX, status = "confirmed", stored: RecordedEvidence["stored"] = null): RecordedEvidence {
  return { txHash: tx, proposalStatus: status, stored };
}

beforeEach(() => {
  resetPublicVerificationState();
});

describe("phase 9 public receipt verification", () => {
  it("uses the canonical transfer topic", () => {
    expect(CHOG_TRANSFER_TOPIC).toBe(keccak256(toBytes(CHOG_TRANSFER_EVENT)));
    expect(CHOG_TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("verifies a successful canonical receipt and does not treat it as a transfer or a settlement", async () => {
    const script = mainnet();
    const batch = await recheckRecordedReceipts({ records: [recorded()], call: script.call, treasury: TREASURY, nowMs: 1_000 });
    expect(script.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
    expect(batch.checks[0]).toMatchObject({
      status: "verified",
      fresh: true,
      cached: false,
      receiptStatus: "success",
      blockNumber: "10",
      blockHash: BLOCK,
      transfers: [],
      settlement: "not_settled",
    });
    expect(batch.checks[0]?.headline).toMatch(/Fresh verification/);
    expect(batch.checks[0]?.transferNote).toMatch(/not a transfer/);
    expect(batch.checks[0]?.settlementNote).toMatch(/did not settle/);
    expect(batch.checks[0]?.explorerHref).toBe(`https://monadscan.com/tx/${TX}`);
  });

  it("labels a reverted receipt and does not decode it as a successful transfer", async () => {
    const script = mainnet({ receipt: receipt([transferLog({})], "0x0") });
    const batch = await recheckRecordedReceipts({ records: [recorded(TX, "reverted")], call: script.call, treasury: TREASURY, nowMs: 1_000 });
    expect(batch.checks[0]).toMatchObject({ status: "reverted", receiptStatus: "reverted", fresh: true, transfers: [] });
    expect(batch.checks[0]?.transferNote).toMatch(/reverted receipt is not a successful transfer/);
    expect(batch.checks[0]?.explorerHref).toBe(`https://monadscan.com/tx/${TX}`);
  });

  it("fails closed for the wrong chain, a hash mismatch, a missing receipt, and bad block metadata", async () => {
    const wrong = mainnet({ chain: "0x27a7" });
    const wrongBatch = await recheckRecordedReceipts({ records: [recorded()], call: wrong.call, nowMs: 1_000, bypassCache: true });
    expect(wrongBatch.checks[0]?.status).toBe("invalid_or_inconsistent");
    expect(wrong.methods).toEqual(["eth_chainId"]);

    resetPublicVerificationState();
    const numeric = mainnet({ chain: 143 });
    expect((await recheckRecordedReceipts({ records: [recorded()], call: numeric.call, nowMs: 2_000, bypassCache: true })).checks[0]?.status).toBe("invalid_or_inconsistent");

    resetPublicVerificationState();
    const mismatched = mainnet({ receipt: receipt([], "0x1", OTHER_TX) });
    const mismatch = await recheckRecordedReceipts({ records: [recorded()], call: mismatched.call, nowMs: 3_000, bypassCache: true });
    expect(mismatch.checks[0]?.status).toBe("invalid_or_inconsistent");
    expect(mismatched.methods).not.toContain("eth_getBlockByNumber");

    resetPublicVerificationState();
    const missing = mainnet({ receipt: null });
    expect((await recheckRecordedReceipts({ records: [recorded()], call: missing.call, nowMs: 4_000, bypassCache: true })).checks[0]?.status).toBe("pending_or_unavailable");

    resetPublicVerificationState();
    const broken = mainnet({ receipt: { transactionHash: TX, status: "0x1", blockNumber: "0xa", blockHash: BLOCK, logs: { bad: true } } });
    expect((await recheckRecordedReceipts({ records: [recorded()], call: broken.call, nowMs: 5_000, bypassCache: true })).checks[0]?.status).toBe("invalid_or_inconsistent");

    resetPublicVerificationState();
    const removed = mainnet({ receipt: receipt([transferLog({ removed: true })]) });
    expect((await recheckRecordedReceipts({ records: [recorded()], call: removed.call, nowMs: 6_000, bypassCache: true })).checks[0]?.status).toBe("invalid_or_inconsistent");

    resetPublicVerificationState();
    const repeated = mainnet({ receipt: receipt([transferLog({ index: 1 }), transferLog({ index: 1, amount: 2n })]) });
    expect((await recheckRecordedReceipts({ records: [recorded()], call: repeated.call, nowMs: 7_000, bypassCache: true })).checks[0]?.status).toBe("invalid_or_inconsistent");

    resetPublicVerificationState();
    const reorg = mainnet({ block: { number: "0xa", hash: OTHER_BLOCK } });
    const moved = await recheckRecordedReceipts({ records: [recorded()], call: reorg.call, nowMs: 8_000, bypassCache: true });
    expect(moved.checks[0]?.status).toBe("invalid_or_inconsistent");
    expect(moved.checks[0]?.explorerHref).toBeNull();
    expect(moved.checks[0]?.headline).toMatch(/not verified/);
  });

  it("maps an RPC failure and a timeout to unavailable without keeping a url", async () => {
    const outage = mainnet({ throwOn: "eth_chainId" });
    const failed = await recheckRecordedReceipts({ records: [recorded()], call: outage.call, nowMs: 1_000, bypassCache: true });
    expect(failed.checks[0]?.status).toBe("pending_or_unavailable");
    expect(failed.checks[0]?.reason).not.toMatch(/https:\/\//);
    expect(failed.checks[0]?.reason).toMatch(/redacted-url/);

    resetPublicVerificationState();
    const hung = mainnet({ hangOn: "eth_getTransactionReceipt" });
    const timed = await recheckRecordedReceipts({
      records: [recorded()],
      call: hung.call,
      nowMs: 2_000,
      timeoutMs: 20,
    });
    expect(timed.checks[0]?.status).toBe("pending_or_unavailable");
    expect(timed.checks[0]?.reason).toMatch(/did not respond in time/);
    expect(timed.checks[0]?.transfers).toEqual([]);
  });

  it("serves a second read from cache and does not call it fresh", async () => {
    const script = mainnet();
    const first = await recheckRecordedReceipts({ records: [recorded()], call: script.call, treasury: TREASURY, nowMs: 1_000 });
    const second = await recheckRecordedReceipts({ records: [recorded()], call: script.call, treasury: TREASURY, nowMs: 10_000 });
    expect(script.methods).toHaveLength(3);
    expect(first.checks[0]?.fresh).toBe(true);
    expect(second.checks[0]?.cached).toBe(true);
    expect(second.checks[0]?.fresh).toBe(false);
    expect(second.checks[0]?.headline).toMatch(/not a fresh verification/);
    expect(second.checks[0]?.status).toBe("verified");

    const later = mainnet({ block: { number: "0xa", hash: OTHER_BLOCK } });
    const stale = await recheckRecordedReceipts({ records: [recorded()], call: later.call, nowMs: 20_000 });
    expect(later.methods).toEqual([]);
    expect(stale.checks[0]?.status).toBe("verified");
    const fresh = await recheckRecordedReceipts({
      records: [recorded()],
      call: later.call,
      nowMs: 1_000 + 30_000,
      bypassCache: true,
    });
    expect(fresh.checks[0]?.status).toBe("invalid_or_inconsistent");
    expect(fresh.checks[0]?.fresh).toBe(true);
  });

  it("shares one in-flight read and pauses when the RPC budget is spent", async () => {
    const script = mainnet();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let receiptCalls = 0;
    const call: RpcCaller = async (method, params) => {
      if (method === "eth_getTransactionReceipt") {
        receiptCalls += 1;
        await gate;
      }
      return script.call(method, params);
    };
    const first = recheckRecordedReceipts({ records: [recorded()], call, nowMs: 5_000 });
    const second = recheckRecordedReceipts({ records: [recorded()], call, nowMs: 5_000 });
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(receiptCalls).toBe(1);
    expect(left.checks[0]?.fresh).toBe(true);
    expect(right.checks[0]?.fresh).toBe(true);

    resetPublicVerificationState();
    const limited = mainnet();
    const other = `0x${"11".repeat(32)}`;
    const batch = await recheckRecordedReceipts({
      records: [recorded(TX), recorded(other)],
      call: limited.call,
      nowMs: 9_000,
      rpcLimit: 1,
    });
    expect(batch.checks).toHaveLength(2);
    expect(batch.checks[0]?.status).toBe("verified");
    expect(batch.checks[1]?.status).toBe("pending_or_unavailable");
    expect(batch.checks[1]?.headline).toMatch(/paused/);
    expect(batch.checks[1]?.cached).toBe(false);
    expect(limited.methods.filter((method) => method === "eth_chainId")).toHaveLength(1);
  });

  it("does not call RPC for a hash that is not recorded economy evidence", async () => {
    const script = mainnet();
    const missing = await recheckRecordedReceipts({
      records: [recorded()],
      call: script.call,
      focusTx: OTHER_TX,
      nowMs: 1_000,
    });
    expect(script.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
    expect(missing.focusNote).toMatch(/not recorded economy evidence/);
    expect(missing.checks.map((check) => check.txHash)).toEqual([TX]);

    const ignored = mainnet();
    const malformed = await recheckRecordedReceipts({ records: [], call: ignored.call, focusTx: "0x123", nowMs: 1_000 });
    expect(ignored.methods).toEqual([]);
    expect(malformed.focusNote).toMatch(/malformed/);
    expect(malformed.checks).toEqual([]);
    expect(malformed.note).toMatch(/does not invent/);
  });

  it("shows a stored block hash that no longer matches the canonical block", async () => {
    const script = mainnet();
    const batch = await recheckRecordedReceipts({
      records: [
        recorded(TX, "confirmed", { chainId: 143, status: "success", blockNumber: "10", blockHash: OTHER_BLOCK }),
      ],
      call: script.call,
      nowMs: 1_000,
    });
    expect(batch.checks[0]?.status).toBe("verified");
    expect(batch.checks[0]?.discrepancy).toMatch(/stored block hash does not match/);
    expect(batch.checks[0]?.discrepancy).toMatch(/not freshly verified/);
    expect(receiptDiscrepancy([{ chainId: 10143, status: "success", blockNumber: "10", blockHash: BLOCK }], {
      status: "success",
      blockNumber: "10",
      blockHash: BLOCK,
    })).toMatch(/not Monad mainnet 143/);
  });

  it("keeps a settled status as a stored fact and does not hide a disagreement", async () => {
    const script = mainnet();
    const settled = await recheckRecordedReceipts({
      records: [recorded(TX, "settled"), recorded(TX, "settled")],
      call: script.call,
      nowMs: 1_000,
    });
    expect(settled.checks).toHaveLength(1);
    expect(settled.checks[0]?.settlement).toBe("stored_settlement");
    expect(settled.checks[0]?.settlementNote).toMatch(/did not settle/);

    resetPublicVerificationState();
    const disputed = await recheckRecordedReceipts({
      records: [recorded(TX, "settled"), recorded(TX, "confirmed")],
      call: mainnet().call,
      nowMs: 2_000,
    });
    expect(disputed.checks[0]?.settlement).toBe("disputed");
  });
});

describe("phase 9 transfer decoding", () => {
  async function verified(logs: unknown[], status: "0x1" | "0x0" = "0x1") {
    const result = await verifyMainnetReceipt({ txHash: TX, call: mainnet({ receipt: receipt(logs, status) }).call });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.receipt;
  }

  it("decodes one supported $CHOG transfer without rounding and without counting it twice", async () => {
    const branded = await verified([transferLog({ amount: AMOUNT })]);
    const first = decodeChogTransfers(branded, TREASURY);
    const second = decodeChogTransfers(branded, TREASURY);
    expect(first.transfers).toHaveLength(1);
    expect(second.transfers).toEqual(first.transfers);
    expect(first.transfers[0]).toMatchObject({
      amountRaw: "10",
      decimals: 18,
      direction: "treasury_in",
      countsInTreasury: false,
      token: addresses.chogToken,
      from: SENDER,
      to: TREASURY,
    });
    expect(first.transfers[0]?.amountRaw).toBe(AMOUNT.toString(10));
    const identities = new Set(first.transfers.map((transfer) => `${transfer.chainId}:${transfer.txHash}:${transfer.logIndex}`));
    expect(identities.size).toBe(1);

    const outgoing = decodeChogTransfers(await verified([transferLog({ from: TREASURY, to: RECIPIENT })]), TREASURY);
    expect(outgoing.transfers[0]?.direction).toBe("treasury_out");
    const external = decodeChogTransfers(await verified([transferLog({ from: SENDER, to: RECIPIENT })]), TREASURY);
    expect(external.transfers[0]?.direction).toBe("external");
    const unattributed = decodeChogTransfers(await verified([transferLog({ from: SENDER, to: RECIPIENT })]), null);
    expect(unattributed.transfers[0]?.direction).toBe("unattributed");
    const ambiguous = decodeChogTransfers(await verified([transferLog({ from: TREASURY, to: TREASURY })]), TREASURY);
    expect(ambiguous.transfers[0]?.direction).toBe("ambiguous");
  });

  it("rejects the wrong contract, an unknown event, a malformed amount, and a receipt with no transfer", async () => {
    const wrongToken = decodeChogTransfers(await verified([transferLog({ token: addresses.wrappedMon })]), TREASURY);
    expect(wrongToken.transfers).toEqual([]);
    expect(wrongToken.note).toMatch(/no supported/);

    const unknown = decodeChogTransfers(
      await verified([transferLog({ topics: [`0x${"44".repeat(32)}`, topicAddress(SENDER), topicAddress(TREASURY)] })]),
      TREASURY,
    );
    expect(unknown.transfers).toEqual([]);

    const malformed = decodeChogTransfers(await verified([transferLog({ data: "0x01" })]), TREASURY);
    expect(malformed.consistent).toBe(false);
    expect(malformed.transfers).toEqual([]);

    const zero = decodeChogTransfers(await verified([transferLog({ amount: 0n })]), TREASURY);
    expect(zero.transfers).toEqual([]);
    expect(zero.consistent).toBe(false);

    const empty = decodeChogTransfers(await verified([]), TREASURY);
    expect(empty.transfers).toEqual([]);
    expect(empty.note).toMatch(/Receipt success is not a transfer/);

    const reverted = decodeChogTransfers(await verified([transferLog({})], "0x0"), TREASURY);
    expect(reverted.transfers).toEqual([]);
    expect(reverted.note).toMatch(/not a successful transfer/);
  });

  it("keeps two logs distinct and does not let a decoded transfer change a journal position", async () => {
    const branded = await verified([
      transferLog({ index: 0, amount: 4n, to: TREASURY }),
      transferLog({ index: 1, amount: 9n, from: TREASURY, to: RECIPIENT }),
    ]);
    const decoded = decodeChogTransfers(branded, TREASURY);
    expect(decoded.transfers.map((transfer) => transfer.amountRaw)).toEqual(["4", "9"]);
    expect(new Set(decoded.transfers.map((transfer) => transfer.logIndex)).size).toBe(2);
    const lines: JournalLine[] = [];
    expect(treasuryPosition(lines, "CHOG")).toBe(0n);
    expect(decoded.transfers.every((transfer) => transfer.countsInTreasury === false)).toBe(true);
    expect(treasuryPosition(lines, "CHOG")).toBe(0n);
  });

  it("does not present a receipt_observed journal row as a counted transfer", () => {
    const ledger = interpretLedgerSnapshot({
      ok: true,
      complete: true,
      reservedGas: "0",
      reservedDeployment: "0",
      allocatedMon: "0",
      allocatedChog: "0",
      dailyGas: "0",
      holds: [],
      proposals: [
        {
          id: "stored",
          status: "confirmed",
          objective: "Pay timber",
          txHash: TX,
          receiptChainId: 143,
          receiptStatus: "success",
          receiptBlockNumber: "10",
          receiptBlockHash: OTHER_BLOCK,
        },
      ],
      transfers: [
        { id: "link", asset: "MON", amountRaw: "1", side: "debit", status: "observed", kind: "receipt_observed", evidenceKey: `143:${TX}:receipt` },
        { id: "real", asset: "CHOG", amountRaw: "10", side: "debit", status: "observed", kind: "treasury_deposit", evidenceKey: `143:${TX}:0:CHOG:in` },
      ],
    });
    expect(ledger.activities[0]?.chainVerified).toBe(false);
    expect(ledger.activities[0]?.storedReceipt).toMatchObject({ chainId: 143, status: "success", blockHash: OTHER_BLOCK });
    expect(ledger.transfers.map((transfer) => transfer.id)).toEqual(["real"]);
  });
});

describe("phase 9 boundaries", () => {
  it("limits a page of recorded hashes and keeps the public route from writing", async () => {
    const records = Array.from({ length: PUBLIC_RECEIPT_LIMIT + 2 }, (_, index) => recorded(`0x${index.toString(16).padStart(64, "0")}`));
    const batch = await recheckRecordedReceipts({ records, call: mainnet().call, nowMs: 50_000, rpcLimit: 100 });
    expect(batch.checks).toHaveLength(PUBLIC_RECEIPT_LIMIT);
    expect(batch.note).toMatch(/were not checked/);

    const response = await getReceipt(new Request("https://chogos.vercel.app/api/economy/receipt?tx=0x123", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, status: "invalid_or_inconsistent" });

    const execution = await postTransaction();
    expect(execution.status).toBe(403);
    expect(productionExecutionStatus({}).enabled).toBe(false);
    expect(productionExecutionStatus({}).signerKind).toBe("none");
  });

  it("does not widen database grants or expose the verifier credential", () => {
    const migrations = readdirSync("supabase/migrations");
    expect(migrations.some((name) => name.includes("phase9"))).toBe(false);
    const verifier = readFileSync("supabase/migrations/20261021000000_phase8_economy_verifier.sql", "utf8");
    expect(verifier).toContain("revoke insert, update, delete, truncate on table economy_journal from service_role");
    expect(verifier).toContain("grant execute on function economy_note_receipt(text, text, text, integer, numeric, text, text) to chogos_economy_verifier");
    const files = [
      "src/lib/economy/public-verification.ts",
      "src/lib/economy/decode-transfer.ts",
      "src/lib/economy/load.ts",
      "src/app/api/economy/receipt/route.ts",
      "src/app/economy/page.tsx",
      "src/components/economy/operations-panel.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("SUPABASE_ECONOMY_VERIFIER_KEY");
      expect(source, file).not.toContain("createEconomyVerifierClient");
      expect(source, file).not.toContain("economy_note_receipt");
      expect(source, file).not.toContain("economy_settle_proposal");
      expect(source, file).not.toContain("economy_append_journal");
      expect(source, file).not.toContain("eth_sendRawTransaction");
    }
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).toContain("assertExecutionDisabled");
    expect(readFileSync("src/app/api/economy/receipt/route.ts", "utf8")).toContain("rateLimit");
  });
});
