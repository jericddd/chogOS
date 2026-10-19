import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addresses } from "@/lib/blockchain/addresses";
import { evaluateSessionExecution } from "@/lib/chogbank/authorization";
import {
  predictedFactoryAddress,
  predictedV2FactoryAddress,
  predictedV2ImplementationAddress,
  V11_FACTORY_PREDICTED,
  V2_FACTORY_PREDICTED,
  V2_IMPLEMENTATION_PREDICTED,
  V2_WALLET_104_PREDICTED,
  V2_WALLET_129_PREDICTED,
} from "@/lib/chogbank/factory";
import { preflightExecuteSession } from "@/lib/chogbank/preflight";
import { evaluateSponsorship } from "@/lib/chogbank/policy";
import { gateRelayerOp } from "@/lib/chogbank/relayer-gate";
import { sessionTransferRace } from "@/lib/chogbank/session-race";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import type { SessionPolicy } from "@/lib/chogbank/types";
import type { WatcherHealth } from "@/lib/watcher/types";

const owner = "0x1111111111111111111111111111111111111111" as const;
const executor = "0x2222222222222222222222222222222222222222" as const;
const account = "0x3333333333333333333333333333333333333333" as const;
const sink = "0x4444444444444444444444444444444444444444" as const;

function health(patch: Partial<WatcherHealth>): WatcherHealth {
  return {
    status: "healthy",
    executionAllowed: true,
    sponsorshipAllowed: true,
    cursorBlock: 10n,
    tipBlock: 10n,
    lagBlocks: 0n,
    lastError: null,
    lastSuccessAt: "2026-10-19T00:00:00.000Z",
    pendingInvalidations: 0,
    failedInvalidations: 0,
    confirmedInvalidations: 0,
    ...patch,
  };
}

function session(): SessionPolicy {
  return {
    executor,
    ownerAtOpen: owner,
    target: sink,
    selector: "0x12345678",
    maxValuePerCall: 10n,
    maxCumulativeValue: 10n,
    spent: 0n,
    expiresAt: 10_000,
    openedBlock: 1n,
    nonce: 0n,
    dead: false,
    paused: false,
  };
}

describe("permanent wallet authorization", () => {
  it("pins a new V2 wallet without moving the unused V1.1 factory", () => {
    expect(predictedFactoryAddress()).toBe(V11_FACTORY_PREDICTED);
    expect(predictedV2FactoryAddress()).toBe(V2_FACTORY_PREDICTED);
    expect(predictedV2ImplementationAddress()).toBe(V2_IMPLEMENTATION_PREDICTED);
    expect(V2_FACTORY_PREDICTED).not.toBe(V11_FACTORY_PREDICTED);
    expect(V2_WALLET_104_PREDICTED).not.toBe(V2_WALLET_129_PREDICTED);
    expect(sessionTransferRace.v11EnforcesTransferAtExecution).toBe(false);
    expect(sessionTransferRace.offchainWatcherClosesRace).toBe(false);
    expect(sessionTransferRace.v2EscrowEpochClosesUnseenRoundTrip).toBe(true);
    expect(sessionTransferRace.v2Factory).toBe(V2_FACTORY_PREDICTED);
    expect(sessionTransferRace.executionRefused).toMatch(/empty transfer list/);

    const solidity = readFileSync("contracts/test/CitizenAccountV2.t.sol", "utf8");
    expect(solidity).toContain(V2_FACTORY_PREDICTED);
    expect(solidity).toContain(V2_IMPLEMENTATION_PREDICTED);
    expect(solidity).toContain(V2_WALLET_104_PREDICTED);
    expect(solidity).toContain(V2_WALLET_129_PREDICTED);
    expect(solidity).toContain("testMissedObservationCannotReviveSession");
    expect(readFileSync("contracts/src/CitizenAccount.sol", "utf8")).toContain("if (owner == previous)");
    expect(readFileSync("contracts/src/CitizenAccountV2.sol", "utf8")).not.toContain("upgradeTo");
    expect(readFileSync("contracts/src/CitizenWalletProxy.sol", "utf8")).toContain("immutable logic");
    expect(readFileSync("contracts/script/DeployCitizenAccountFactoryV2.s.sol", "utf8")).not.toContain("startBroadcast");
  });

  it("refuses a session when the watcher is lagging, stalled, or the RPC failed", () => {
    const input = {
      chainId: 143,
      nftContract: addresses.chogGenesis,
      account,
      tokenId: "104",
      expectedTokenId: "104",
      expectedAccount: account,
      currentOwner: owner,
      session: session(),
      transfersAfterOpen: [],
    };
    expect(preflightExecuteSession({ ...input, health: health({ status: "lagging", executionAllowed: false, sponsorshipAllowed: false, lagBlocks: 100n, tipBlock: 110n }) }).ok).toBe(false);
    expect(preflightExecuteSession({ ...input, health: health({ status: "stalled", executionAllowed: false, sponsorshipAllowed: false }) }).ok).toBe(false);
    const rpc = preflightExecuteSession({
      ...input,
      health: health({ status: "error", executionAllowed: false, sponsorshipAllowed: false, lastError: "rpc timeout" }),
    });
    expect(rpc.ok).toBe(false);
    const healthy = preflightExecuteSession({ ...input, health: health({}) });
    expect(healthy.ok).toBe(false);
    if (!healthy.ok) expect(healthy.reason).toMatch(/empty transfer list/);
  });

  it("keeps the server path closed even when the offchain checks would otherwise look clean", () => {
    const evaluated = evaluateSessionExecution({
      session: session(),
      currentOwner: owner,
      executor,
      target: sink,
      selector: "0x12345678",
      valueWei: 1n,
      expectedNonce: 0n,
      now: 1_000,
      transfersAfterOpen: [],
    });
    expect(evaluated.ok).toBe(false);
    if (!evaluated.ok) expect(evaluated.reason).toMatch(/empty transfer list/);

    const sponsored = evaluateSponsorship({
      job: {
        requestId: "req-v2",
        idempotencyKey: "v2-session",
        op: "account.executeSession",
        target: sink,
        selector: "0x12345678",
        valueWei: 1n,
        estimatedGasWei: 1n,
      },
      sessionAlive: true,
      sessionSelector: "0x12345678",
      sessionTarget: sink,
      treasury: { configured: true, chainId: 143, availableWei: 10n ** 18n, reservedWei: 0n, source: "injected" },
      limits: {
        maxActivationWei: 10n ** 18n,
        maxTxWei: 10n ** 18n,
        maxDailyGasWei: 10n ** 18n,
        maxTreasuryExposureWei: 10n ** 18n,
      },
      dailyGasSpentWei: 0n,
      duplicate: null,
      relayerEnabled: true,
    });
    expect(sponsored).toMatchObject({ action: "reject", reason: sessionTransferRace.executionRefused });

    const gated = gateRelayerOp({
      op: "account.executeSession",
      chainId: 143,
      signer: loadProtectedSigner({}),
      mode: "simulated",
      reservationHeld: true,
      treasuryConfigured: true,
      preflightOk: true,
    });
    expect(gated.accepted).toBe(false);
  });
});
