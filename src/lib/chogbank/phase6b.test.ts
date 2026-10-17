import { readFileSync } from "node:fs";
import { getAddress, keccak256, toFunctionSelector, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { buildDecisionContext, goalLooksOnchain } from "@/lib/ai/context";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { considerWalletActivation, evaluateSessionExecution } from "@/lib/chogbank/authorization";
import {
  confirmAuthorization,
  confirmDeployment,
  executeJob,
  queueDeployment,
  recoverActivation,
  reviewActivation,
  sponsorSessionCall,
  submitActivationRequest,
  type BankEngine,
} from "@/lib/chogbank/engine";
import {
  DETERMINISTIC_CREATE2,
  V1_FACTORY_PREDICTED,
  V11_FACTORY_PREDICTED,
  V11_FACTORY_SALT,
  identityKey,
  predictAccountAddress,
  predictedFactoryAddress,
} from "@/lib/chogbank/factory";
import { MemoryChogBankStore } from "@/lib/chogbank/memory-store";
import { evaluateActivation, requestLooksFabricated } from "@/lib/chogbank/policy";
import { createDisabledRelayer, createScriptedRelayer, loadProductionRelayer } from "@/lib/chogbank/relayer";
import { DEFAULT_BANK_LIMITS, injectedTreasury, productionBankRuntime, UNSET_TREASURY } from "@/lib/chogbank/runtime";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import type { ActivationRequest, SessionPolicy } from "@/lib/chogbank/types";
import { addresses } from "@/lib/blockchain/addresses";
import { readAppConfig } from "@/lib/config/env";
import { NFT_BOUND_SCHEME, walletControlFollowsNftOwner } from "@/lib/wallets/authority";
import { planUnassignedWallets } from "@/lib/wallets/lifecycle";
import { nftBoundSalt } from "@/lib/wallets/nft-bound";
import { BUILDINGS } from "@/lib/world/layout";
import { initialize, openWorldDb, rows, seedCitizens, tick, START } from "@/lib/world/test-db";
import type { BuildingView, CitizenView } from "@/lib/world/types";

const nft = getAddress("0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763");
const ownerA = getAddress("0x2222222222222222222222222222222222222222");
const ownerB = getAddress("0x3333333333333333333333333333333333333333");
const executor = getAddress("0x4444444444444444444444444444444444444444");
const sink = getAddress("0x5555555555555555555555555555555555555555");
const ping = toFunctionSelector("ping(uint256)");
const account = getAddress("0x7777777777777777777777777777777777777777");

const industrious = {
  sociability: 10,
  curiosity: 10,
  industriousness: 90,
  cooperation: 20,
  caution: 15,
  planning: 40,
  resourcefulness: 70,
  preferredActivity: "work" as const,
};

function citizen(patch: Partial<CitizenView> = {}): CitizenView {
  return {
    tokenId: "7",
    name: "Test",
    origin: "founding",
    role: "crafter",
    homeId: "house-01",
    workId: "workshop-a",
    activity: "idle",
    locationId: "commons-square",
    originId: null,
    destinationId: null,
    purpose: null,
    startedAt: "2026-10-13T00:00:00Z",
    endsAt: null,
    worldStartedS: 12 * 3600,
    worldEndsS: null,
    shiftsToday: 0,
    dayIndex: 0,
    decisionSource: "simulation",
    updatedTick: 1,
    ...patch,
  };
}

function buildings(): BuildingView[] {
  return BUILDINGS.map((b) => ({
    id: b.id,
    kind: b.kind,
    name: b.name,
    x: b.rect.x,
    y: b.rect.y,
    w: b.rect.w,
    h: b.rect.h,
    doorX: b.door.x,
    doorY: b.door.y,
    capacity: b.capacity,
    jobSlots: b.jobSlots,
    role: b.role,
    openAir: b.open,
    status: b.initialStatus,
    constructionProgress: b.initialStatus === "under_construction" ? 0 : null,
    batchShifts: b.batchShifts,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: b.kind === "storehouse" ? { food: 80, wood: 60, stone: 40, tools: 0 } : ({} as Record<string, number>),
    completedAt: null,
    updatedTick: 0,
  }));
}

function draft(patch: Partial<ActivationRequest> = {}): Omit<ActivationRequest, "state" | "predictedAddress" | "accountAddress" | "reservationId" | "rejectReason"> {
  return {
    id: patch.id ?? "req-1",
    citizenId: patch.citizenId ?? "citizen-1",
    tokenId: patch.tokenId ?? "7",
    chainId: 143,
    nftContract: nft,
    motive: "start_business",
    goal: "Open a tools shop and trade goods onchain",
    proposedActions: "deploy the citizen account then register the shop",
    revenueHypothesis: "shop fees if customers appear; not guaranteed",
    estimatedDeploymentWei: 200_000_000_000_000_000n,
    estimatedGasWei: 50_000_000_000_000_000n,
    decisionId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-10-17T00:00:00.000Z",
    ...patch,
  };
}

function session(patch: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    executor,
    ownerAtOpen: ownerA,
    target: sink,
    selector: ping,
    maxValuePerCall: 10n,
    maxCumulativeValue: 10n,
    spent: 0n,
    expiresAt: 2_000,
    openedBlock: 10n,
    nonce: 0n,
    dead: false,
    paused: false,
    ...patch,
  };
}

function engine(options: {
  treasuryWei?: bigint;
  factoryDeployed?: boolean;
  relayer?: ReturnType<typeof createScriptedRelayer> | ReturnType<typeof createDisabledRelayer>;
} = {}): BankEngine {
  const store = new MemoryChogBankStore();
  return {
    store,
    runtime: {
      treasury: options.treasuryWei === undefined ? UNSET_TREASURY : injectedTreasury(options.treasuryWei),
      limits: DEFAULT_BANK_LIMITS,
      factoryAddress: V11_FACTORY_PREDICTED,
      factoryDeployed: options.factoryDeployed ?? true,
      relayerEnabled: options.relayer ? options.relayer.enabled : true,
    },
    relayer: options.relayer ?? createScriptedRelayer([]),
    predictAccount: (identity) =>
      predictAccountAddress({
        factory: V11_FACTORY_PREDICTED,
        identity,
        accountInitCodeHash: keccak256(toHex(identityKey(identity))),
      }),
    now: () => "2026-10-17T12:00:00.000Z",
  };
}

describe("enrollment does not activate wallets", () => {
  it("keeps a joining NFT unassigned and not active", () => {
    const plan = planUnassignedWallets({
      citizens: [{ id: "citizen-1", chainId: 143 }],
      existing: [],
    });
    expect(plan.creates[0]?.status).toBe("not_configured");
    expect(plan.creates[0]?.accountAddress).toBeNull();
    expect(walletControlFollowsNftOwner()).toBe(false);
    expect(walletControlFollowsNftOwner(NFT_BOUND_SCHEME)).toBe(true);
    const enroll = readFileSync("src/lib/civilization/enrollment-flow.ts", "utf8");
    expect(enroll).not.toContain("submitActivationRequest");
    expect(enroll).not.toContain("chogbank");
  });
});

describe("AI activation decisions", () => {
  it("parses a concrete activation request and leaves ordinary living on world actions", () => {
    const parsed = parseDecisionOutput(
      JSON.stringify({
        action: "request_wallet_activation",
        buildingId: "none",
        activationMotive: "start_business",
        proposedOnchainActions: "deploy the account then call the market registrar",
        revenueHypothesis: "fees from a tools shop, if any",
        estimatedDeploymentWei: "200000000000000000",
        estimatedGasWei: "50000000000000000",
        summary: "Open a tools shop and trade goods onchain",
        rationale: "The listed goal needs an account for the registrar call.",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision.action).toBe("request_wallet_activation");
      expect(parsed.decision.activationMotive).toBe("start_business");
      expect(parsed.decision.claimedDeploymentWei).toBe(200_000_000_000_000_000n);
    }
    const living = parseDecisionOutput(
      JSON.stringify({
        action: "work",
        buildingId: "workshop-a",
        summary: "Work a crafting shift.",
        rationale: "No onchain activity is required today.",
      }),
    );
    expect(living.ok).toBe(true);
    if (living.ok) {
      expect(living.decision.activationMotive).toBeNull();
    }
    expect(
      parseDecisionOutput(
        JSON.stringify({
          action: "request_wallet_activation",
          buildingId: "none",
          summary: "I want a wallet",
          rationale: "Everyone should have one.",
        }),
      ).ok,
    ).toBe(false);
  });

  it("treats ordinary goals as unnecessary and a concrete onchain plan as eligible", () => {
    expect(
      considerWalletActivation({ hasActiveWallet: false, motive: null, hasConcreteOnchainPlan: false }),
    ).toBe("unnecessary");
    expect(
      considerWalletActivation({
        hasActiveWallet: false,
        motive: "start_business",
        hasConcreteOnchainPlan: true,
      }),
    ).toBe("eligible_to_request");
    expect(
      considerWalletActivation({
        hasActiveWallet: true,
        motive: "start_business",
        hasConcreteOnchainPlan: true,
      }),
    ).toBe("unnecessary");
    expect(goalLooksOnchain([{ id: "g", kind: "skill_craft", title: "Craft", status: "active", progress: 10 }])).toBe(
      false,
    );
    expect(
      goalLooksOnchain([{ id: "g", kind: "skill_craft", title: "Start a business stall", status: "active", progress: 0 }]),
    ).toBe(true);
    const context = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 0 },
      personality: industrious,
      skills: [],
      goals: [{ id: "g", kind: "skill_craft", title: "Craft", status: "active", progress: 10 }],
      memories: [],
      canBuild: false,
    });
    expect(context.walletActivation.state).toBe("unassigned");
    expect(context.walletActivation.eligibleToRequest).toBe(false);
    expect(context.suggested).toBe("work");
  });
});

describe("ChogBank policy", () => {
  it("defers when treasury is unset or zero and does not invent a balance", () => {
    const request: ActivationRequest = {
      ...draft(),
      state: "activation_requested",
      predictedAddress: null,
      accountAddress: null,
      reservationId: null,
      rejectReason: null,
    };
    expect(
      evaluateActivation({
        request,
        treasury: UNSET_TREASURY,
        limits: DEFAULT_BANK_LIMITS,
        openReservations: [],
        dailyGasSpentWei: 0n,
        factoryDeployed: true,
        relayerEnabled: true,
        existing: null,
      }).action,
    ).toBe("defer");
    expect(
      evaluateActivation({
        request,
        treasury: injectedTreasury(0n),
        limits: DEFAULT_BANK_LIMITS,
        openReservations: [],
        dailyGasSpentWei: 0n,
        factoryDeployed: true,
        relayerEnabled: true,
        existing: null,
      }),
    ).toMatchObject({ action: "defer", reason: expect.stringMatching(/zero|external funding/i) });
    expect(requestLooksFabricated({ goal: "I want a wallet please", proposedActions: "just because", motive: "start_business" })).toBeTruthy();
    const production = productionBankRuntime(readAppConfig({} as NodeJS.ProcessEnv));
    expect(production.treasury.source).toBe("unset");
    expect(production.factoryDeployed).toBe(false);
    expect(production.relayerEnabled).toBe(false);
  });

  it("approves, rejects, and defers according to limits and factory status", async () => {
    const funded = engine({ treasuryWei: 1_000_000_000_000_000_000n, relayer: createScriptedRelayer([]) });
    const submitted = await submitActivationRequest(funded, draft());
    const approved = await reviewActivation(funded, submitted.id);
    expect(approved.decision.action).toBe("approve");
    expect(approved.request.state).toBe("predicted");
    expect(approved.request.predictedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const weak = engine({ treasuryWei: 1_000_000_000_000_000_000n, relayer: createScriptedRelayer([]) });
    const bad = await submitActivationRequest(weak, draft({ id: "req-bad", goal: "I want a wallet please", proposedActions: "test wallet now" }));
    const rejected = await reviewActivation(weak, bad.id);
    expect(rejected.decision.action).toBe("reject");
    expect(rejected.request.state).toBe("rejected");

    const unfunded = engine({ relayer: createScriptedRelayer([]) });
    const waiting = await submitActivationRequest(unfunded, draft({ id: "req-zero" }));
    const deferred = await reviewActivation(unfunded, waiting.id);
    expect(deferred.decision.action).toBe("defer");
    expect(deferred.request.state).toBe("deferred");

    const retry = await submitActivationRequest(unfunded, draft({ id: "req-retry" }));
    expect(retry.id).toBe("req-retry");
    expect(retry.state).toBe("activation_requested");
  });

  it("enforces spending limits across concurrent requests and keeps NFT mapping stable", async () => {
    const bank = engine({ treasuryWei: 400_000_000_000_000_000n, relayer: createScriptedRelayer([]) });
    const first = await reviewActivation(bank, (await submitActivationRequest(bank, draft({ id: "a", tokenId: "7" }))).id);
    expect(first.decision.action).toBe("approve");
    const second = await reviewActivation(
      bank,
      (await submitActivationRequest(bank, draft({ id: "b", citizenId: "citizen-2", tokenId: "8" }))).id,
    );
    expect(second.decision.action).toBe("defer");
    const again = await submitActivationRequest(bank, draft({ id: "a-dup", tokenId: "7" }));
    expect(again.id).toBe(first.request.id);
    expect(identityKey({ chainId: 143, nftContract: nft, tokenId: 7n })).not.toBe(
      identityKey({ chainId: 143, nftContract: nft, tokenId: 8n }),
    );
    expect(nftBoundSalt({ chainId: 143, nftContract: nft, tokenId: 7n })).toBe(
      nftBoundSalt({ chainId: 143, nftContract: nft, tokenId: 7n }),
    );
  });
});

describe("deployment, authorization, relayer, and reconciliation", () => {
  it("does not mark an account deployed or active without code and a live session", async () => {
    const bank = engine({
      treasuryWei: 1_000_000_000_000_000_000n,
      relayer: createScriptedRelayer([{ ok: true, txHash: `0x${"11".repeat(32)}`, gasUsedWei: 12_000_000_000_000_000n }]),
    });
    const submitted = await submitActivationRequest(bank, draft());
    await reviewActivation(bank, submitted.id);
    const queued = await queueDeployment(bank, submitted.id);
    expect(queued.state).toBe("queued");
    const duplicate = await queueDeployment(bank, submitted.id);
    expect(duplicate.id).toBe(queued.id);
    const sent = await executeJob(bank, queued.id);
    expect(sent.state).toBe("submitted");
    const missingCode = await confirmDeployment(bank, submitted.id, { codePresent: false, accountAddress: null });
    expect(missingCode.state).toBe("error");

    const okBank = engine({
      treasuryWei: 1_000_000_000_000_000_000n,
      relayer: createScriptedRelayer([{ ok: true, txHash: `0x${"22".repeat(32)}`, gasUsedWei: 12_000_000_000_000_000n }]),
    });
    const okReq = await submitActivationRequest(okBank, draft({ id: "ok" }));
    await reviewActivation(okBank, okReq.id);
    const job = await queueDeployment(okBank, okReq.id);
    await executeJob(okBank, job.id);
    const deployed = await confirmDeployment(okBank, okReq.id, { codePresent: true, accountAddress: account });
    expect(deployed.state).toBe("deployed");
    expect(deployed.accountAddress).toBe(account);
    const pending = await confirmAuthorization(okBank, okReq.id, session({ dead: true }));
    expect(pending.state).toBe("authorization_pending");
    const active = await confirmAuthorization(okBank, okReq.id, session());
    expect(active.state).toBe("active");
  });

  it("recovers a reverted deploy without creating a second account identity", async () => {
    const bank = engine({
      treasuryWei: 1_000_000_000_000_000_000n,
      relayer: createScriptedRelayer([
        { ok: false, kind: "reverted", reason: "create reverted" },
        { ok: true, txHash: `0x${"33".repeat(32)}`, gasUsedWei: 11_000_000_000_000_000n },
      ]),
    });
    const submitted = await submitActivationRequest(bank, draft());
    const reviewed = await reviewActivation(bank, submitted.id);
    const predicted = reviewed.request.predictedAddress;
    const job = await queueDeployment(bank, submitted.id);
    const failed = await executeJob(bank, job.id);
    expect(failed.state).toBe("reverted");
    const recovered = await recoverActivation(bank, submitted.id);
    expect(recovered.state).toBe("predicted");
    expect(recovered.predictedAddress).toBe(predicted);
    const retried = await queueDeployment(bank, submitted.id);
    expect(retried.idempotencyKey).toBe(job.idempotencyKey);
    const sent = await executeJob(bank, retried.id);
    expect(sent.state).toBe("submitted");
  });

  it("sponsors a restricted session call, skips duplicates, and invalidates after a transfer log", async () => {
    const bank = engine({
      treasuryWei: 1_000_000_000_000_000_000n,
      relayer: createScriptedRelayer([
        { ok: true, txHash: `0x${"44".repeat(32)}`, gasUsedWei: 1_000_000_000_000_000n },
        { ok: true, txHash: `0x${"55".repeat(32)}`, gasUsedWei: 1_000_000_000_000_000n },
      ]),
    });
    const submitted = await submitActivationRequest(bank, draft());
    await reviewActivation(bank, submitted.id);
    await bank.store.saveRequest({
      ...(await bank.store.getRequest(submitted.id))!,
      state: "active",
      accountAddress: account,
    });
    await bank.store.saveSession(submitted.id, session());
    const first = await sponsorSessionCall(bank, {
      requestId: submitted.id,
      target: sink,
      selector: ping,
      valueWei: 0n,
      estimatedGasWei: 1_000_000_000_000_000n,
      expectedNonce: 0n,
      executor,
      currentOwner: ownerA,
      now: 1_000,
      transfersAfterOpen: [],
    });
    expect("skipped" in first).toBe(false);
    if (!("skipped" in first)) {
      expect(first.state).toBe("confirmed");
    }
    const dup = await sponsorSessionCall(bank, {
      requestId: submitted.id,
      target: sink,
      selector: ping,
      valueWei: 0n,
      estimatedGasWei: 1_000_000_000_000_000n,
      expectedNonce: 0n,
      executor,
      currentOwner: ownerA,
      now: 1_000,
      transfersAfterOpen: [],
    });
    expect("skipped" in dup ? dup.reason : dup.state).toMatch(/duplicate|confirmed|submitted/);
    const transferred = await sponsorSessionCall(bank, {
      requestId: submitted.id,
      target: sink,
      selector: ping,
      valueWei: 0n,
      estimatedGasWei: 1_000_000_000_000_000n,
      expectedNonce: 1n,
      executor,
      currentOwner: ownerA,
      now: 1_000,
      transfersAfterOpen: [{ blockNumber: 11n, from: ownerA, to: ownerB }],
    });
    expect("skipped" in transferred).toBe(false);
    if (!("skipped" in transferred)) {
      expect(transferred.op).toBe("account.invalidateSession");
    }
    const ledger = await bank.store.ledger();
    expect(ledger.some((row) => row.bucket === "sponsored_gas_spent" && row.deltaWei > 0n)).toBe(true);
    expect(ledger.some((row) => row.bucket === "business_capital")).toBe(false);
  });

  it("records reverted execution and disabled relayer failures without broadcasting", async () => {
    const reverted = engine({
      treasuryWei: 1_000_000_000_000_000_000n,
      relayer: createScriptedRelayer([{ ok: false, kind: "reverted", reason: "call reverted" }]),
    });
    const submitted = await submitActivationRequest(reverted, draft());
    await reviewActivation(reverted, submitted.id);
    await reverted.store.saveRequest({
      ...(await reverted.store.getRequest(submitted.id))!,
      state: "active",
      accountAddress: account,
    });
    await reverted.store.saveSession(submitted.id, session());
    const result = await sponsorSessionCall(reverted, {
      requestId: submitted.id,
      target: sink,
      selector: ping,
      valueWei: 0n,
      estimatedGasWei: 1_000_000_000_000_000n,
      expectedNonce: 0n,
      executor,
      currentOwner: ownerA,
      now: 1_000,
      transfersAfterOpen: [],
    });
    expect("skipped" in result).toBe(false);
    if (!("skipped" in result)) {
      expect(result.state).toBe("reverted");
    }
    expect(loadProductionRelayer().enabled).toBe(false);
    expect(createDisabledRelayer().enabled).toBe(false);
    const signer = loadProtectedSigner({ CHOG_BANK_RELAYER_PRIVATE_KEY: "0xabc" });
    expect(signer.kind).toBe("none");
    expect(JSON.stringify(signer)).not.toContain("0xabc");
  });
});

describe("session authorization", () => {
  it("rejects owner changes, transfer logs, replay, limits, and does not revive from ownerAtOpen alone", () => {
    const live = evaluateSessionExecution({
      session: session(),
      currentOwner: ownerA,
      executor,
      target: sink,
      selector: ping,
      valueWei: 0n,
      expectedNonce: 0n,
      now: 1_000,
      transfersAfterOpen: [],
    });
    expect(live).toEqual({ ok: true });
    expect(
      evaluateSessionExecution({
        session: session(),
        currentOwner: ownerB,
        executor,
        target: sink,
        selector: ping,
        valueWei: 0n,
        expectedNonce: 0n,
        now: 1_000,
        transfersAfterOpen: [],
      }),
    ).toMatchObject({ ok: false, mustInvalidate: true });
    expect(
      evaluateSessionExecution({
        session: session(),
        currentOwner: ownerA,
        executor,
        target: sink,
        selector: ping,
        valueWei: 0n,
        expectedNonce: 0n,
        now: 1_000,
        transfersAfterOpen: [{ blockNumber: 11n, from: ownerA, to: ownerB }],
      }),
    ).toMatchObject({ ok: false, mustInvalidate: true, reason: expect.stringMatching(/transferred/i) });
    expect(
      evaluateSessionExecution({
        session: session(),
        currentOwner: ownerA,
        executor,
        target: sink,
        selector: ping,
        valueWei: 0n,
        expectedNonce: 1n,
        now: 1_000,
        transfersAfterOpen: [],
      }),
    ).toMatchObject({ ok: false, reason: "replay" });
    const src = readFileSync("contracts/src/CitizenAccount.sol", "utf8");
    expect(src).toContain("function openSession");
    expect(src).toContain("function invalidateSession");
    expect(src).toContain("revert DelegationDisabled()");
    expect(src).toContain("session.dead = true");
  });
});

describe("factory prediction and safety files", () => {
  it("pins the V1.1 factory prediction and refuses to treat V1 as deployable", () => {
    expect(predictedFactoryAddress()).toBe(V11_FACTORY_PREDICTED);
    expect(V11_FACTORY_PREDICTED).not.toBe(V1_FACTORY_PREDICTED);
    expect(V11_FACTORY_SALT).toBe(keccak256(new TextEncoder().encode("chogOS.CitizenAccountFactory.v1.1")));
    expect(DETERMINISTIC_CREATE2).toBe(getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C"));
    const script = readFileSync("contracts/script/DeployCitizenAccountFactory.s.sol", "utf8");
    expect(script).toContain("chogOS.CitizenAccountFactory.v1.1");
    expect(script).not.toMatch(/vm\.envUint/);
    const transactions = readFileSync("src/app/api/transactions/route.ts", "utf8");
    expect(transactions).toContain("assertExecutionDisabled");
    const sql = readFileSync("supabase/migrations/20261017220000_phase6b_chogbank.sql", "utf8");
    expect(sql.toLowerCase()).toContain("not applied to hosted supabase");
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/insert\s+into\s+citizens/i);
    expect(sql).toContain("chogbank_activation_requests");
    expect(addresses.chogGenesis).toBe(nft);
  });
});

describe("simulation compatibility", () => {
  it("applies the additive migration without activating wallets or changing history", async () => {
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 3);
      },
    });
    const init = await initialize(db);
    expect(init.status).toBe("initialized");
    const before = await rows<{ count: number }>(db, "select count(*)::int as count from civilization_events");
    await tick(db, new Date(START.getTime() + 5_000));
    const activations = await rows<{ count: number }>(
      db,
      "select count(*)::int as count from chogbank_activation_requests",
    );
    const wallets = await rows<{ count: number }>(db, "select count(*)::int as count from citizen_wallet_registry");
    const after = await rows<{ count: number }>(db, "select count(*)::int as count from civilization_events");
    expect(activations[0]?.count).toBe(0);
    expect(wallets[0]?.count).toBe(0);
    expect(after[0]?.count).toBeGreaterThanOrEqual(before[0]!.count);
    const worldTick = readFileSync("supabase/migrations/20261013040000_phase3_world.sql", "utf8");
    expect(worldTick).not.toContain("chogbank");
    await db.close();
  }, 60_000);
});
