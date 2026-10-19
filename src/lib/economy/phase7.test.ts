import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { addresses } from "@/lib/blockchain/addresses";
import { V2_FACTORY_PREDICTED, V2_WALLET_104_PREDICTED, V2_WALLET_129_PREDICTED } from "@/lib/chogbank/factory";
import { gateRelayerOp } from "@/lib/chogbank/relayer-gate";
import { productionBankRuntime } from "@/lib/chogbank/runtime";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import { readAppConfig } from "@/lib/config/env";
import { EXECUTABLE_ADAPTERS, adapterMayExecute } from "@/lib/economy/adapters";
import { parseProtocolAllowlist } from "@/lib/economy/allowlist";
import { parseRawAmount } from "@/lib/economy/amounts";
import { productionExecutionStatus } from "@/lib/economy/execution";
import {
  appendPosting,
  journalFromModelClaim,
  proposeAccounting,
  realizeSupported,
  reconcileChainTransfer,
  spendSupported,
  treasuryPosition,
  realizedAmount,
  type ChainTransferEvidence,
} from "@/lib/economy/journal";
import {
  assessTreasuryRead,
  economicAddressProblem,
  readEconomicTreasury,
  type TreasuryReader,
  type TreasurySnapshot,
} from "@/lib/economy/observe";
import { presentEconomy } from "@/lib/economy/present";
import { evaluateProductionEconomy } from "@/lib/economy/production";
import {
  decideEconomicProposal,
  parseEconomicProposal,
  proposalFromDraft,
  type EconomicProposal,
  type EconomyLimits,
} from "@/lib/economy/proposal";
import { holdSequentially, settleHold, tryHold, type Hold } from "@/lib/economy/reserve";
import { noteReceipt, noteSubmission, openProposal, retryProposal, settleProposal } from "@/lib/economy/workflow";

const NOW = Date.parse("2026-10-19T00:00:00.000Z");

function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const GAS = getAddress("0x2222222222222222222222222222222222222222");
const TARGET = getAddress("0x3333333333333333333333333333333333333333");
const OTHER = getAddress("0x4444444444444444444444444444444444444444");
const SELECTOR = "0xa9059cbb" as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;

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

function reader(partial: Partial<TreasuryReader> & Pick<TreasuryReader, "getChainId">): TreasuryReader {
  return {
    getBlockNumber: async () => 10n,
    getNativeBalance: async () => 0n,
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 18,
    ...partial,
  };
}

function fresh(mon: bigint, chog: bigint, decimals = 6): TreasurySnapshot {
  return assessTreasuryRead({
    address: TREASURY,
    read: {
      chainId: 143,
      blockNumber: 10n,
      observedAt: new Date(NOW).toISOString(),
      nativeRaw: mon,
      tokenRaw: chog,
      tokenDecimals: decimals,
    },
    nowMs: NOW,
    maxAgeMs: 60_000,
  });
}

function proposal(overrides: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    id: "proposal-1",
    idempotencyKey: "proposal-1",
    citizenId: "citizen-104",
    tokenId: "104",
    nftContract: addresses.chogGenesis,
    objective: "Buy timber for the workshop",
    rationale: "The listed goal needs a payment for timber.",
    operation: "payment",
    target: TARGET,
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

function evidence(overrides: Partial<ChainTransferEvidence> = {}): ChainTransferEvidence {
  return {
    chainId: 143,
    txHash: TX,
    logIndex: null,
    status: "success",
    asset: "MON",
    amountRaw: 1_000n,
    direction: "in",
    treasury: TREASURY,
    counterparty: OTHER,
    blockNumber: 10n,
    ...overrides,
  };
}

describe("economic treasury observation", () => {
  it("rejects a wrong chain and does not keep the unread balances", async () => {
    let balances = 0;
    const snapshot = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({
        getChainId: async () => 10143,
        getNativeBalance: async () => {
          balances += 1;
          return 9n;
        },
      }),
    });
    expect(snapshot.status).toBe("wrong_chain");
    expect(snapshot.observedChainId).toBe(10143);
    expect(snapshot.mon.raw).toBeNull();
    expect(snapshot.chog.raw).toBeNull();
    expect(snapshot.unallocatedMon).toBeNull();
    expect(balances).toBe(0);
    expect(readAppConfig(env({ MONAD_CHAIN_ID: "10143" })).chainId).toBe(10143);
    const configured = await evaluateProductionEconomy({
      config: readAppConfig(env({ MONAD_CHAIN_ID: "10143", CHOG_BANK_ASSET_ADDRESS: TREASURY, CHOG_BANK_GAS_ADDRESS: GAS })),
      proposal: proposal(),
      nowMs: NOW,
      dailyGasKnown: true,
    });
    expect(configured.observation.status).toBe("wrong_chain");
    expect(configured.decision.reserved).toBe(false);
  });

  it("reports unset, stale, timed out, malformed, and unavailable reads without inventing zero", async () => {
    const unset = await readEconomicTreasury({
      address: null,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({ getChainId: async () => Promise.reject(new Error("should not be called")) }),
    });
    expect(unset.status).toBe("not_configured");
    expect(unset.mon.raw).toBeNull();

    const stale = assessTreasuryRead({
      address: TREASURY,
      read: {
        chainId: 143,
        blockNumber: 4n,
        observedAt: new Date(NOW - 120_000).toISOString(),
        nativeRaw: 5n,
        tokenRaw: 6n,
        tokenDecimals: 6,
      },
      nowMs: NOW,
      maxAgeMs: 1_000,
    });
    expect(stale.status).toBe("stale");
    expect(stale.mon.raw).toBe(5n);
    expect(stale.unallocatedMon).toBeNull();
    expect(stale.unallocatedChog).toBeNull();

    const timedOut = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      timeoutMs: 20,
      reader: reader({ getChainId: () => new Promise(() => undefined) }),
    });
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.mon.raw).toBeNull();

    const malformed = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({
        getChainId: async () => 143,
        getNativeBalance: async () => -1n,
        getTokenBalance: async () => 1n,
        getTokenDecimals: async () => 99,
      }),
    });
    expect(malformed.status).toBe("malformed");
    expect(malformed.mon.raw).toBeNull();

    const unavailable = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({
        getChainId: async () => Promise.reject(new Error("failed https://rpc.example/secret?token=abc")),
      }),
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toContain("[redacted-url]");
    expect(unavailable.reason).not.toContain("https://");
    expect(unavailable.mon.raw).toBeNull();

    const noRpc = await readEconomicTreasury({ address: TREASURY, nowMs: NOW, maxAgeMs: 60_000 });
    expect(noRpc.status).toBe("unavailable");
  });

  it("keeps MON wei and $CHOG base units exact and reads decimals from the contract", async () => {
    const mon = 10n ** 18n + 1n;
    const chog = 1_500_000n;
    const snapshot = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reservedGasWei: 2n,
      reservedDeploymentWei: 3n,
      allocatedMon: 4n,
      allocatedChog: 500_000n,
      reader: reader({
        getChainId: async () => 143,
        getBlockNumber: async () => 42n,
        getNativeBalance: async () => mon,
        getTokenBalance: async () => chog,
        getTokenDecimals: async () => 6,
      }),
    });
    expect(snapshot.status).toBe("observed");
    expect(snapshot.mon.raw).toBe(mon);
    expect(snapshot.mon.decimals).toBe(18);
    expect(snapshot.chog.raw).toBe(chog);
    expect(snapshot.chog.decimals).toBe(6);
    expect(snapshot.unallocatedMon).toBe(mon - 9n);
    expect(snapshot.unallocatedChog).toBe(1_000_000n);
    expect(snapshot.mon.raw).not.toBe(snapshot.chog.raw);
    expect(parseRawAmount(1.5)).toBeNull();
    expect(parseRawAmount("1.5")).toBeNull();
    expect(parseRawAmount("1e2")).toBeNull();
    expect(parseRawAmount(mon.toString(10))).toBe(mon);

    const wrongToken = await readEconomicTreasury({
      address: TREASURY,
      token: addresses.wrappedMon,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({ getChainId: async () => 143 }),
    });
    expect(wrongToken.status).toBe("malformed");
  });

  it("does not substitute the NFT treasury when the economic address is unset or forbidden", async () => {
    const config = readAppConfig(env());
    expect(config.chogBankAssetAddress).toBeUndefined();
    expect(config.chogTreasuryAddress).toBe(addresses.chogTreasury);
    const missing = await evaluateProductionEconomy({ config, proposal: proposal(), nowMs: NOW, dailyGasKnown: true });
    expect(missing.observation.status).toBe("not_configured");
    expect(missing.observation.address).toBeNull();
    expect(
      economicAddressProblem(addresses.chogTreasury, {
        nftTreasury: addresses.chogTreasury,
        nft: addresses.chogGenesis,
        token: addresses.chogToken,
        gas: GAS,
      }),
    ).toMatch(/ChogTreasury NFT wallet/);
    const guarded = await evaluateProductionEconomy({
      config: readAppConfig(env({ CHOG_BANK_ASSET_ADDRESS: addresses.chogTreasury, CHOG_BANK_GAS_ADDRESS: GAS })),
      proposal: proposal(),
      nowMs: NOW,
      dailyGasKnown: true,
    });
    expect(guarded.observation.status).toBe("malformed");
    expect(guarded.observation.mon.raw).toBeNull();
  });
});

describe("reservations and ledger", () => {
  it("applies two reservations sequentially and refuses the overspend", () => {
    const requests = [60n, 60n].map((amount, index) => ({
      id: `hold-${index}`,
      key: `key-${index}`,
      proposalId: `citizen-104:104:proposal-${index}`,
      tokenId: "104",
      asset: "MON" as const,
      bucket: "business_capital" as const,
      amountRaw: amount,
      observedRaw: 100n,
    }));
    const raced = [tryHold([], requests[0]!), tryHold([], requests[1]!)];
    expect(raced.every((result) => result.ok)).toBe(true);
    const serial = holdSequentially([], requests);
    expect(serial.results[0]?.ok).toBe(true);
    expect(serial.results[1]?.ok).toBe(false);
    if (!serial.results[1]?.ok) {
      expect(serial.results[1].outcome).toBe("insufficient_funds");
    }
    expect(serial.holds).toHaveLength(1);
    const replay = tryHold(serial.holds, requests[0]!);
    expect(replay.ok && replay.created).toBe(false);
    expect(settleHold(serial.holds, "key-0", "failed")[0]?.state).toBe("released");
  });

  it("reconciles a transfer once and ignores missing, reverted, and duplicate evidence", () => {
    const missing = reconcileChainTransfer([], evidence({ status: "missing" }), "t");
    expect(missing.ok && missing.counted).toBe(false);
    expect(treasuryPosition(missing.ok ? missing.lines : [], "MON")).toBe(0n);

    const reverted = reconcileChainTransfer([], evidence({ status: "reverted", direction: "out" }), "t");
    expect(reverted.ok && reverted.counted).toBe(false);
    const revertedAgain = reconcileChainTransfer(reverted.ok ? reverted.lines : [], evidence({ status: "reverted", direction: "out" }), "t");
    expect(revertedAgain.ok && revertedAgain.duplicate).toBe(true);
    expect((revertedAgain.ok ? revertedAgain.lines : []).length).toBe(reverted.ok ? reverted.lines.length : 0);

    const posted = reconcileChainTransfer([], evidence(), "t");
    expect(posted.ok && posted.counted).toBe(true);
    const again = reconcileChainTransfer(posted.ok ? posted.lines : [], evidence(), "t");
    expect(again.ok && again.duplicate).toBe(true);
    expect(treasuryPosition(again.ok ? again.lines : [], "MON")).toBe(1_000n);
    const outgoing = reconcileChainTransfer(again.ok ? again.lines : [], evidence({ direction: "out", txHash: `0x${"cd".repeat(32)}` as Hex }), "t");
    expect(treasuryPosition(outgoing.ok ? outgoing.lines : [], "MON")).toBe(0n);
    expect(reconcileChainTransfer([], evidence({ chainId: 10143 }), "t").ok).toBe(false);
    const unbalanced = appendPosting([], [
      {
        postingId: "one",
        account: "treasury",
        asset: "MON",
        amountRaw: 1n,
        side: "debit",
        kind: "treasury_deposit",
        source: "proposal",
        ref: "one",
        status: "proposed",
        evidenceKey: null,
        citizenTokenId: null,
        at: "t",
      },
    ]);
    expect(unbalanced.ok).toBe(false);
  });

  it("realizes revenue and losses only from matching evidence and does not double-credit", () => {
    expect(journalFromModelClaim("the treasury received 10 MON and earned a profit")).toBeNull();
    const proposed = proposeAccounting([], {
      postingId: "proposal-post",
      kind: "earnings",
      asset: "MON",
      amountRaw: 1_000n,
      ref: "proposal:1",
      at: "t",
    });
    expect(proposed.ok).toBe(true);
    expect(treasuryPosition(proposed.ok ? proposed.lines : [], "MON")).toBe(0n);
    expect(realizedAmount(proposed.ok ? proposed.lines : [], "earnings", "MON")).toBe(0n);

    const claim = realizeSupported([], {
      kind: "earnings",
      asset: "MON",
      amountRaw: 1_000n,
      evidence: evidence({ status: "missing" }),
      at: "t",
    });
    expect(claim.ok).toBe(false);

    const earned = realizeSupported([], {
      kind: "earnings",
      asset: "MON",
      amountRaw: 1_000n,
      evidence: evidence(),
      at: "t",
    });
    expect(earned.ok).toBe(true);
    const lines = earned.ok ? earned.lines : [];
    expect(treasuryPosition(lines, "MON")).toBe(1_000n);
    expect(realizedAmount(lines, "earnings", "MON")).toBe(1_000n);
    const twice = realizeSupported(lines, {
      kind: "earnings",
      asset: "MON",
      amountRaw: 1_000n,
      evidence: evidence(),
      at: "t",
    });
    expect(twice.ok && twice.duplicate).toBe(true);
    expect(treasuryPosition(twice.ok ? twice.lines : [], "MON")).toBe(1_000n);

    const lost = realizeSupported([], {
      kind: "loss_realized",
      asset: "MON",
      amountRaw: 40n,
      evidence: evidence({ direction: "out", amountRaw: 40n, txHash: `0x${"ef".repeat(32)}` as Hex }),
      at: "t",
    });
    expect(lost.ok).toBe(true);
    expect(treasuryPosition(lost.ok ? lost.lines : [], "MON")).toBe(-40n);
    expect(realizedAmount(lost.ok ? lost.lines : [], "loss_realized", "MON")).toBe(40n);
    expect(
      realizeSupported([], {
        kind: "loss_realized",
        asset: "MON",
        amountRaw: 40n,
        evidence: evidence({ direction: "in", amountRaw: 40n }),
        at: "t",
      }).ok,
    ).toBe(false);

    const spent = spendSupported([], {
      kind: "gas_spent",
      amountRaw: 7n,
      evidence: evidence({ direction: "out", amountRaw: 7n, txHash: `0x${"11".repeat(32)}` as Hex }),
      at: "t",
    });
    expect(spent.ok).toBe(true);
    expect(realizedAmount(spent.ok ? spent.lines : [], "gas_spent", "MON")).toBe(7n);
    expect(treasuryPosition(spent.ok ? spent.lines : [], "MON")).toBe(-7n);
  });
});

describe("policy, allowlist, and production gates", () => {
  const rules = parseProtocolAllowlist(
    JSON.stringify([{ chainId: 143, target: TARGET, selectors: [SELECTOR], assets: ["MON", "CHOG"], label: "fixture" }]),
  ).rules;

  it("keeps an empty or malformed allowlist closed and rejects unknown selectors", () => {
    expect(parseProtocolAllowlist(undefined).rules).toEqual([]);
    expect(parseProtocolAllowlist("{").rules).toEqual([]);
    expect(parseProtocolAllowlist("[]").rules).toEqual([]);
    expect(parseProtocolAllowlist(JSON.stringify([{ chainId: 10143, target: TARGET, selectors: [SELECTOR], assets: ["MON"], label: "no" }])).rules).toEqual([]);
    expect(EXECUTABLE_ADAPTERS).toEqual([]);
    const swap = parseEconomicProposal(
      {
        operation: "swap",
        asset: "MON",
        amountRaw: "1000",
        estimatedGasWei: "1",
        fundingRequestRaw: "1000",
        objective: "Swap MON for CHOG",
        rationale: "A listed goal needs a swap.",
        expectedOutcome: "Only a real quote could price this.",
        idempotencyKey: "swap-1",
        citizenId: "citizen-104",
        tokenId: "104",
        nftContract: addresses.chogGenesis,
      },
      NOW,
    );
    expect(swap.ok).toBe(false);
    expect(adapterMayExecute([], TARGET, SELECTOR, "MON").executable).toBe(false);
    const decided = decideEconomicProposal({
      proposal: proposal({ target: OTHER }),
      observation: fresh(10_000n, 0n),
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: true,
      nowMs: NOW,
      executionEnabled: true,
    });
    expect(decided.decision.outcome).toBe("unsupported_protocol");
    expect(decided.decision.executed).toBe(false);
    expect(decided.holds).toEqual([]);
  });

  it("blocks a missing factory and reserves only inside the local execution flag", () => {
    const observation = fresh(10_000n, 9_000n);
    const blocked = decideEconomicProposal({
      proposal: proposal(),
      observation,
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: true,
    });
    expect(blocked.decision.outcome).toBe("deferred");
    expect(blocked.decision.reason).toMatch(/predicted/);
    expect(blocked.holds).toEqual([]);

    const disabled = decideEconomicProposal({
      proposal: proposal(),
      observation,
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: true,
      nowMs: NOW,
      executionEnabled: false,
    });
    expect(disabled.decision.outcome).toBe("deferred");
    expect(disabled.decision.reason).toMatch(/execution is disabled/);
    expect(disabled.decision.reserved).toBe(false);

    const approved = decideEconomicProposal({
      proposal: proposal(),
      observation,
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: true,
      nowMs: NOW,
      executionEnabled: true,
    });
    expect(approved.decision.outcome).toBe("approved");
    expect(approved.decision.executed).toBe(false);
    expect(approved.decision.reserved).toBe(true);
    expect(approved.holds.map((hold) => hold.bucket).sort()).toEqual(["business_capital", "gas"]);
    const second = decideEconomicProposal({
      proposal: proposal({ id: "proposal-2", idempotencyKey: "proposal-2", fundingRequestRaw: 9_500n, amountRaw: 9_500n }),
      observation,
      holds: approved.holds,
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: true,
      nowMs: NOW,
      executionEnabled: true,
    });
    expect(second.decision.outcome).toBe("insufficient_funds");
    expect(second.holds).toEqual(approved.holds);
  });

  it("enforces citizen, business, gas, and token budgets", () => {
    const observation = fresh(10n ** 21n, 10n ** 12n);
    const base = {
      observation,
      holds: [] as Hold[],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: rules,
      factoryDeployed: true,
      nowMs: NOW,
      executionEnabled: true,
    };
    expect(decideEconomicProposal({ ...base, proposal: proposal({ amountRaw: LIMITS.maxTxWei + 1n }) }).decision.outcome).toBe("rejected");
    expect(
      decideEconomicProposal({
        ...base,
        proposal: proposal({ asset: "CHOG", amountRaw: 1n, fundingRequestRaw: 1n }),
        limits: { ...LIMITS, maxChogPerTxRaw: 0n },
      }).decision.outcome,
    ).toBe("budget_exhausted");
    expect(
      decideEconomicProposal({
        ...base,
        dailyGasWei: LIMITS.maxDailyGasWei,
        proposal: proposal({ estimatedGasWei: 1n }),
      }).decision.outcome,
    ).toBe("budget_exhausted");
    const citizenHeld: Hold = {
      id: "existing",
      key: "existing",
      proposalId: "citizen-104:104:old",
      tokenId: "104",
      asset: "MON",
      bucket: "business_capital",
      amountRaw: LIMITS.maxCitizenCapitalWei,
      state: "held",
    };
    expect(decideEconomicProposal({ ...base, holds: [citizenHeld], proposal: proposal() }).decision.outcome).toBe("budget_exhausted");
    expect(
      decideEconomicProposal({
        ...base,
        limits: { ...LIMITS, maxBusinessAllocationWei: 50n },
        proposal: proposal({ fundingRequestRaw: 51n, amountRaw: 51n }),
      }).decision.outcome,
    ).toBe("budget_exhausted");
    const poor = decideEconomicProposal({
      ...base,
      observation: fresh(5n, 0n),
      proposal: proposal({ fundingRequestRaw: 10n, amountRaw: 10n, estimatedGasWei: 1n }),
    });
    expect(poor.decision.outcome).toBe("insufficient_funds");
  });

  it("keeps production signing, executeSession, and the transactions route disabled", async () => {
    const productionEnv = env({
      CHOG_BANK_RELAYER_ENABLED: "true",
      CHOG_BANK_RELAYER_PRIVATE_KEY: "0xabc",
      CITIZEN_ACCOUNT_FACTORY_ADDRESS: V2_FACTORY_PREDICTED,
      CITIZEN_ACCOUNT_FACTORY_CODE_VERIFIED: "true",
    });
    const status = productionExecutionStatus(productionEnv);
    expect(status.enabled).toBe(false);
    expect(status.signerKind).toBe("none");
    expect(status.relayerEnabled).toBe(false);
    expect(status.executeSessionAccepted).toBe(false);
    expect(status.gateAccepted).toBe(false);
    expect(status.transactionsRoute).toBe("closed");
    expect(JSON.stringify(status)).not.toContain("0xabc");
    expect(readFileSync("src/lib/blockchain/execution.ts", "utf8")).toContain("throw new TransactionExecutionDisabledError");
    expect(loadProtectedSigner(productionEnv).kind).toBe("none");
    expect(productionBankRuntime(readAppConfig(productionEnv)).relayerEnabled).toBe(false);
    expect(
      gateRelayerOp({
        op: "account.executeSession",
        chainId: 143,
        signer: loadProtectedSigner({}),
        mode: "production",
        reservationHeld: true,
        treasuryConfigured: true,
        preflightOk: true,
      }    ).accepted,
    ).toBe(false);
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).toContain("assertExecutionDisabled");
    expect(readFileSync("src/lib/economy/production.ts", "utf8")).toContain("executionEnabled: false");
    expect(readFileSync("src/lib/economy/production.ts", "utf8")).toContain("factoryDeployed: false");
    expect(readFileSync("src/lib/economy/observe.ts", "utf8")).not.toMatch(/sendTransaction|writeContract|deployContract|signTransaction|walletClient/);

    const evaluated = await evaluateProductionEconomy({
      config: readAppConfig(env({
        CHOG_BANK_RELAYER_ENABLED: "true",
        CITIZEN_ACCOUNT_FACTORY_ADDRESS: V2_FACTORY_PREDICTED,
        CITIZEN_ACCOUNT_FACTORY_CODE_VERIFIED: "true",
        ECONOMY_PROTOCOL_ALLOWLIST: JSON.stringify([{ chainId: 143, target: TARGET, selectors: [SELECTOR], assets: ["MON"], label: "fixture" }]),
      })),
      proposal: proposal(),
      nowMs: NOW,
      dailyGasKnown: true,
      observation: fresh(10_000n, 0n),
    });
    expect(evaluated.decision.outcome).toBe("deferred");
    expect(evaluated.decision.reserved).toBe(false);
    expect(evaluated.holds).toEqual([]);
    expect(productionBankRuntime(readAppConfig(env())).factoryDeployed).toBe(false);
  });
});

describe("proposals, identity, and presentation", () => {
  it("keeps tokens 104 and 129 on their predicted wallets and ignores model funding claims", () => {
    const wallet104 = V2_WALLET_104_PREDICTED;
    const wallet129 = V2_WALLET_129_PREDICTED;
    const parsed = parseEconomicProposal(
      {
        operation: "business",
        asset: "MON",
        amountRaw: "1000",
        estimatedGasWei: "1",
        fundingRequestRaw: "1000",
        objective: "Open a tools shop",
        rationale: "The listed goal needs a payment.",
        expectedOutcome: "The treasury received 10 MON.",
        idempotencyKey: "tools-104",
        citizenId: "citizen-104",
        tokenId: "104",
        nftContract: addresses.chogGenesis,
        owner: OTHER,
        profitRaw: "999999",
      },
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.proposal.tokenId).toBe("104");
      expect(parsed.proposal.nftContract).toBe(addresses.chogGenesis);
      expect(parsed.proposal).not.toHaveProperty("owner");
      expect(parsed.proposal).not.toHaveProperty("profitRaw");
    }
    const other = parseEconomicProposal(
      {
        operation: "business",
        asset: "MON",
        amountRaw: "1000",
        estimatedGasWei: "1",
        fundingRequestRaw: "1000",
        objective: "Open a tools shop",
        rationale: "The listed goal needs a payment.",
        expectedOutcome: "A later receipt would be required.",
        idempotencyKey: "tools-129",
        citizenId: "citizen-129",
        tokenId: "129",
        nftContract: addresses.chogGenesis,
      },
      NOW,
    );
    expect(other.ok && other.proposal.tokenId).toBe("129");
    expect(V2_WALLET_104_PREDICTED).toBe(wallet104);
    expect(V2_WALLET_129_PREDICTED).toBe(wallet129);
    expect(journalFromModelClaim("The treasury received 10 MON.")).toBeNull();

    const decision = parseDecisionOutput(
      JSON.stringify({
        action: "propose_economy",
        buildingId: "",
        summary: "Pay for timber",
        rationale: "The workshop needs timber.",
        economy: {
          operation: "payment",
          asset: "MON",
          amountRaw: "1000",
          estimatedGasWei: "1",
          fundingRequestRaw: "1000",
          expectedOutcome: "Timber arrives only after a receipt.",
          tokenId: "999",
          citizenId: "someone-else",
        },
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.decision.economy) {
      const bound = proposalFromDraft(decision.decision.economy, {
        id: "decision-1",
        idempotencyKey: "economy:decision-1",
        citizenId: "citizen-104",
        tokenId: "104",
        nftContract: addresses.chogGenesis,
        nowMs: NOW,
      });
      expect(bound.tokenId).toBe("104");
      expect(bound.citizenId).toBe("citizen-104");
    }
    expect(readFileSync("src/lib/ai/context.ts", "utf8")).toContain("propose_economy");
    expect(readFileSync("src/lib/ai/runner.ts", "utf8")).toContain("evaluateProductionEconomy");
    expect(readFileSync("src/lib/ai/runner.ts", "utf8")).not.toContain("sendTransaction");
  });

  it("does not present a proposal or a simulated job as a confirmed transaction", () => {
    const opened = openProposal([], { id: "1", idempotencyKey: "tools-104", tokenId: "104", expiresAtMs: NOW + 1_000, at: "t0" });
    const again = openProposal(opened.records, { id: "2", idempotencyKey: "tools-104", tokenId: "104", expiresAtMs: NOW + 1_000, at: "t1" });
    expect(again.created).toBe(false);
    expect(again.records).toHaveLength(1);
    let records = noteSubmission(opened.records, "tools-104", "t1");
    expect(records[0]?.status).toBe("proposed");
    records = noteReceipt(records, "tools-104", { status: "success", txHash: TX }, "t2");
    expect(records[0]?.status).toBe("proposed");
    records = [{ ...records[0]!, status: "approved", reason: "reserved in a local test" }];
    records = noteSubmission(records, "tools-104", "t3");
    expect(records[0]?.status).toBe("submitted");
    records = noteReceipt(records, "tools-104", { status: "missing", txHash: null }, "t4");
    expect(records[0]?.status).toBe("submitted");
    records = noteReceipt(records, "tools-104", { status: "success", txHash: TX }, "t5");
    expect(records[0]?.status).toBe("confirmed");
    expect(records[0]?.executed).toBe(false);
    records = settleProposal(records, "tools-104", "t6");
    expect(records[0]?.status).toBe("settled");
    const retried = retryProposal(
      [{ ...opened.record, status: "deferred", reason: "later" }],
      "tools-104",
      "t7",
      NOW,
    );
    expect(retried.ok).toBe(true);

    const view = presentEconomy({
      snapshot: assessTreasuryRead({ address: null, read: null, nowMs: NOW, maxAgeMs: 1_000 }),
      execution: productionExecutionStatus({}),
      allowlistReason: "No protocol allowlist is configured.",
      ledgerLoaded: false,
      activities: [
        {
          id: "sim",
          status: "submitted",
          summary: "Simulated payment",
          reason: "Simulation only.",
          simulated: true,
          txHash: TX,
          chainVerified: false,
        },
      ],
      transfers: [
        {
          id: "plain",
          direction: "in",
          asset: "MON",
          amountRaw: "1",
          decimals: 18,
          txHash: TX,
          chainVerified: false,
          status: "proposed",
        },
      ],
    });
    expect(view.monText).toBe("Not read");
    expect(view.reservedGas).toBe("Not loaded");
    expect(view.unallocatedMon).toBe("Not available");
    expect(view.execution).toBe("Disabled");
    expect(view.activities[0]?.href).toBeNull();
    expect(view.transfers[0]?.href).toBeNull();
    expect(view.ledgerNote).toMatch(/not shown as zero/);
  });

  it("locks the new tables to service role and keeps the migration free of secrets", () => {
    const sql = readFileSync("supabase/migrations/20261019230000_phase7_economy.sql", "utf8").toLowerCase();
    expect(sql).toContain("for update");
    expect(sql).toContain("numeric(78, 0)");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("service_role");
    expect(sql).toContain("revoke all");
    expect(sql).toContain("chain_id = 143");
    expect(sql).toContain("execution_enabled = false");
    expect(sql).toContain("append-only");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toMatch(/0x[0-9a-f]{64}/);
    expect(readFileSync("src/components/shell/nav.tsx", "utf8")).not.toContain('href: "/economy"');
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).not.toContain("economy_try_hold");
  });
});
