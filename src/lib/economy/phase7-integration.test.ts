import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { applyHeldReservations, assessTreasuryRead, withLedgerReservations } from "@/lib/economy/observe";
import { persistEconomyDecision, type EconomyGateway } from "@/lib/economy/persist";
import { decideEconomicProposal, type EconomicProposal, type EconomyLimits } from "@/lib/economy/proposal";
import { applyRpcVerification, interpretLedgerSnapshot, LEDGER_PENDING, LEDGER_UNREAD } from "@/lib/economy/ledger";
import { assessReceiptEvidence, receiptRpcArgs, settleRpcArgs } from "@/lib/economy/receipt";
import { verifyMainnetReceipt } from "@/lib/economy/verify-receipt";
import type { Hex } from "viem";

const NOW = Date.parse("2026-10-19T00:00:00.000Z");
const CITIZEN = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";
const SELECTOR = "0xa9059cbb" as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;
const BLOCK = `0x${"cd".repeat(32)}` as Hex;

const LIMITS: EconomyLimits = {
  maxCitizenCapitalWei: 1_000_000_000_000_000_000n,
  maxBusinessAllocationWei: 2_000_000_000_000_000_000n,
  maxTxWei: 100_000_000_000_000_000n,
  maxDailyGasWei: 1_000_000_000_000_000_000n,
  maxTreasuryExposureWei: 5_000_000_000_000_000_000n,
  maxChogPerTxRaw: 1_000_000n,
  maxCitizenChogRaw: 5_000_000n,
  maxBusinessChogRaw: 2_000_000n,
};

function proposal(overrides: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    id: "proposal-1",
    idempotencyKey: "proposal-1",
    citizenId: CITIZEN,
    tokenId: "104",
    nftContract: addresses.chogGenesis,
    objective: "Buy timber for the workshop",
    rationale: "The listed goal needs a payment for timber.",
    operation: "payment",
    target: TARGET as EconomicProposal["target"],
    selector: SELECTOR,
    asset: "MON",
    amountRaw: 1_000n,
    estimatedGasWei: 10n,
    fundingRequestRaw: 1_000n,
    expectedOutcome: "Timber is delivered if a later receipt succeeds.",
    quotePriceRaw: null,
    slippageBps: null,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

function fresh() {
  return assessTreasuryRead({
    address: "0x1111111111111111111111111111111111111111",
    read: {
      chainId: 143,
      blockNumber: 10n,
      observedAt: new Date(NOW).toISOString(),
      nativeRaw: 10_000n,
      tokenRaw: 0n,
      tokenDecimals: 6,
    },
    nowMs: NOW,
    maxAgeMs: 60_000,
  });
}

function gateway(
  calls: string[],
  holds: EconomyGateway["tryHolds"] = async (rows, operationId) => ({
    ok: true,
    created: true,
    createdKeys: rows.map((row) => row.key),
    operationId,
  }),
): EconomyGateway {
  return {
    async openProposal() {
      calls.push("open");
      return { ok: true, id: PROPOSAL_ID, created: true };
    },
    async applyStatus(input) {
      calls.push(`status:${input.status}`);
      return { ok: true, status: input.status, duplicate: false };
    },
    async tryHolds(rows, operationId) {
      calls.push(`holds:${rows.length}`);
      return holds(rows, operationId);
    },
    async release(proposalId) {
      calls.push(`release:${proposalId}`);
      return { ok: true };
    },
  };
}

describe("persistent proposals and offchain holds", () => {
  it("writes the proposal and audit status before treating an offchain hold as saved", async () => {
    const calls: string[] = [];
    const decided = decideEconomicProposal({
      proposal: proposal(),
      observation: fresh(),
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: [{ chainId: 143, target: TARGET as EconomicProposal["nftContract"], selectors: [SELECTOR], assets: ["MON"], label: "fixture" }],
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: false,
    });
    const saved = await persistEconomyDecision(gateway(calls), {
      proposal: proposal(),
      decision: decided.decision,
      holds: decided.holds,
      observation: fresh(),
    });
    expect(saved).toMatchObject({ ok: true, proposalId: PROPOSAL_ID, status: "approved", reserved: true });
    expect(calls).toEqual(["open", "holds:2", "status:approved"]);
  });

  it("keeps a failed reservation off the approved status", async () => {
    const calls: string[] = [];
    const decided = decideEconomicProposal({
      proposal: proposal(),
      observation: fresh(),
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: [{ chainId: 143, target: TARGET as EconomicProposal["nftContract"], selectors: [SELECTOR], assets: ["MON"], label: "fixture" }],
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: false,
    });
    const saved = await persistEconomyDecision(
      gateway(calls, async () => ({ ok: false, outcome: "insufficient_funds", reason: "The remaining observed balance cannot cover another reservation." })),
      { proposal: proposal(), decision: decided.decision, holds: decided.holds, observation: fresh() },
    );
    expect(saved).toMatchObject({ ok: true, status: "insufficient_funds", reserved: false });
    expect(calls).toEqual(["open", "holds:2", "status:insufficient_funds"]);
  });

  it("releases a new hold when the status write fails", async () => {
    const calls: string[] = [];
    const decided = decideEconomicProposal({
      proposal: proposal(),
      observation: fresh(),
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: [{ chainId: 143, target: TARGET as EconomicProposal["nftContract"], selectors: [SELECTOR], assets: ["MON"], label: "fixture" }],
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: false,
    });
    const failing = gateway(calls);
    failing.applyStatus = async () => ({ ok: false, reason: "The proposal status could not be saved." });
    const saved = await persistEconomyDecision(failing, {
      proposal: proposal(),
      decision: decided.decision,
      holds: decided.holds,
      observation: fresh(),
    });
    expect(saved).toMatchObject({ ok: false, reserved: false });
    expect(calls).toEqual(["open", "holds:2", `release:${PROPOSAL_ID}`]);
  });

  it("does not open a proposal for an identity the server did not issue", async () => {
    const calls: string[] = [];
    const saved = await persistEconomyDecision(gateway(calls), {
      proposal: proposal({ citizenId: "citizen-104" }),
      decision: { outcome: "deferred", reason: "later", hold: null, reserved: false, executed: false },
      holds: [],
      observation: fresh(),
    });
    expect(saved.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("loaded ledger and verified settlement", () => {
  it("treats a missing or partial snapshot as unread", () => {
    expect(interpretLedgerSnapshot(null).complete).toBe(false);
    expect(interpretLedgerSnapshot({ ok: true, complete: false, reason: LEDGER_PENDING }).reason).toBe(LEDGER_PENDING);
    expect(interpretLedgerSnapshot({ ok: true, complete: true, reservedGas: 1 }).complete).toBe(false);
    expect(interpretLedgerSnapshot({ ok: false }).reason).toBe(LEDGER_UNREAD);
  });

  it("loads holds and links only a verified receipt", () => {
    const ledger = interpretLedgerSnapshot({
      ok: true,
      complete: true,
      reservedGas: "10",
      reservedDeployment: "0",
      allocatedMon: "1000",
      allocatedChog: "0",
      dailyGas: "4",
      holds: [
        {
          id: "hold-1",
          key: "proposal-1",
          proposalId: PROPOSAL_ID,
          tokenId: "104",
          asset: "MON",
          bucket: "business_capital",
          amountRaw: "1000",
          state: "held",
        },
      ],
      proposals: [
        { id: "plain", status: "confirmed", objective: "Pay timber", reason: "Hash only.", txHash: TX },
        {
          id: "verified",
          status: "confirmed",
          objective: "Pay timber",
          reason: "Receipt matched.",
          txHash: TX,
          receiptChainId: 143,
          receiptStatus: "success",
          receiptBlockNumber: "10",
          receiptBlockHash: BLOCK,
        },
      ],
      transfers: [
        { id: "proposed", asset: "MON", amountRaw: "5", side: "debit", status: "proposed", evidenceKey: `143:${TX}:native:MON:in` },
        { id: "seen", asset: "MON", amountRaw: "1000", side: "debit", status: "observed", evidenceKey: `143:${TX}:native:MON:in` },
      ],
    });
    expect(ledger.complete).toBe(true);
    expect(ledger.holds).toHaveLength(1);
    expect(ledger.reservedGasRaw).toBe("10");
    expect(ledger.activities[0]?.chainVerified).toBe(false);
    expect(ledger.activities[1]?.chainVerified).toBe(false);
    expect(ledger.activities[1]?.simulated).toBe(true);
    expect(ledger.transfers.map((transfer) => transfer.id)).toEqual(["seen"]);
    expect(ledger.transfers[0]?.chainVerified).toBe(false);
    expect(applyRpcVerification(ledger, null).activities[1]?.chainVerified).toBe(false);
    const viewed = applyHeldReservations(fresh(), {
      reservedGasWei: 10n,
      reservedDeploymentWei: 0n,
      allocatedMon: 1000n,
      allocatedChog: 0n,
    });
    expect(viewed.unallocatedMon).toBe(10_000n - 1_010n);
    expect(withLedgerReservations(fresh(), null).unallocatedMon).toBeNull();
  });

  it("refuses settlement args unless the receipt was read from mainnet RPC", async () => {
    const shaped = assessReceiptEvidence({
      chainId: 143,
      observedChainId: 143,
      txHash: TX,
      status: "success",
      blockNumber: 10n,
      blockHash: BLOCK,
    });
    expect(shaped.ok).toBe(true);
    if (!shaped.ok) {
      return;
    }
    expect(receiptRpcArgs("proposal-1", shaped.evidence, "matched").ok).toBe(false);
    expect(settleRpcArgs("proposal-1", shaped.evidence).ok).toBe(false);
    const success = await verifyMainnetReceipt({
      txHash: TX,
      call: async (method) => {
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_getTransactionReceipt") {
          return { transactionHash: TX, status: "0x1", blockNumber: "0xa", blockHash: BLOCK };
        }
        if (method === "eth_getBlockByNumber") return { number: "0xa", hash: BLOCK };
        throw new Error(method);
      },
    });
    const reverted = await verifyMainnetReceipt({
      txHash: TX,
      call: async (method) => {
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_getTransactionReceipt") {
          return { transactionHash: TX, status: "0x0", blockNumber: "0xa", blockHash: BLOCK };
        }
        if (method === "eth_getBlockByNumber") return { number: "0xa", hash: BLOCK };
        throw new Error(method);
      },
    });
    expect(success.ok).toBe(true);
    expect(reverted.ok).toBe(true);
    if (!success.ok || !reverted.ok) {
      return;
    }
    expect(receiptRpcArgs("proposal-1", success.receipt, "matched").ok).toBe(true);
    expect(settleRpcArgs("proposal-1", success.receipt)).toEqual({
      ok: true,
      args: { p_key: "proposal-1", p_tx: TX },
    });
    expect(settleRpcArgs("proposal-1", reverted.receipt).ok).toBe(false);
    expect(assessReceiptEvidence({
      chainId: 143,
      observedChainId: 143,
      txHash: TX,
      status: "success",
      blockNumber: null,
      blockHash: null,
    }).ok).toBe(false);
  });
});
