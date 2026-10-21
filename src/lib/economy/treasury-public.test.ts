import { encodeAbiParameters, getAddress, keccak256, toBytes, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { decodeBankLog, withoutFundedTransfers } from "@/lib/economy/treasury-logs";
import { pendingInspection, presentOwnerlessTreasury, type OwnerlessInspection, type VerifiedDistribution } from "@/lib/economy/treasury-public";

const BANK = getAddress("0x2222222222222222222222222222222222222222");
const AUTHORIZER = getAddress("0x1111111111111111111111111111111111111111");
const HASH = `0x${"ab".repeat(32)}`;
const DECISION = `0x${"cd".repeat(32)}`;

function live(overrides: Partial<OwnerlessInspection> = {}): OwnerlessInspection {
  return {
    appChainId: 143,
    configuredAddress: BANK,
    blockedReason: null,
    codeBytes: 2400,
    observedChainId: 143,
    genesis: addresses.chogGenesis,
    chogToken: addresses.chogToken,
    authorizer: AUTHORIZER,
    implementationSlot: `0x${"00".repeat(32)}`,
    adminSlot: `0x${"00".repeat(32)}`,
    ownerCall: "reverted",
    adminCall: "reverted",
    implementationCall: "reverted",
    upgradeCall: "reverted",
    monRaw: 2_000_000_000_000_000_000n,
    chogRaw: 5_000_000_000_000_000_000n,
    chogDecimals: 18,
    chainCaps: {
      windowSeconds: 86_400,
      maxAuthorizationTtl: 3_600,
      maxPerTxMon: 100_000_000_000_000_000n,
      maxCitizenWindowMon: 1_000_000_000_000_000_000n,
      maxAggregateWindowMon: 2_000_000_000_000_000_000n,
      maxPerTxChog: 10n,
      maxCitizenWindowChog: 20n,
      maxAggregateWindowChog: 30n,
    },
    deploymentTx: null,
    deploymentTxVerified: false,
    readError: null,
    ...overrides,
  };
}

describe("public ownerless treasury", () => {
  it("shows a deployment-pending state with no address, balance, or explorer link", () => {
    const view = presentOwnerlessTreasury({ inspection: pendingInspection(143), decisions: [], decisionsLoaded: true });
    expect(view.fundingReady).toBe(false);
    expect(view.fundingAddress).toBeNull();
    expect(view.explorerContractHref).toBeNull();
    expect(view.deploymentTxHref).toBeNull();
    expect(view.sourceVerified).toBe(false);
    expect(view.monText).toBe("Not read");
    expect(view.chogText).toBe("Not read");
    expect(view.summary).toContain("not deployed");
    expect(view.execution).toContain("disabled");
    expect(view.policy.join(" ")).toContain("outside deposit()");
    expect(view.funding.join(" ")).toContain("No funding address");
    expect(view.warnings.join(" ")).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("rejects the NFT holder, empty code, a proxy slot, and an owner return", () => {
    const nft = presentOwnerlessTreasury({
      inspection: live({ configuredAddress: addresses.chogTreasury, codeBytes: 100 }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(nft.fundingAddress).toBeNull();
    expect(nft.warnings.join(" ")).toContain("NFT holder");

    const empty = presentOwnerlessTreasury({
      inspection: live({ codeBytes: 0, chainCaps: null }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(empty.fundingAddress).toBeNull();
    expect(empty.monText).toBe("Not read");
    expect(empty.warnings.join(" ")).toContain("no contract code");

    const proxy = presentOwnerlessTreasury({
      inspection: live({ implementationSlot: `0x${"11".repeat(32)}` }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(proxy.fundingReady).toBe(false);
    expect(proxy.warnings.join(" ")).toContain("EIP-1967");

    const owned = presentOwnerlessTreasury({
      inspection: live({ ownerCall: "returned" }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(owned.fundingAddress).toBeNull();
    expect(owned.warnings.join(" ")).toContain("owner()");
  });

  it("shows a checked contract without claiming source verification or a deployment transaction", () => {
    const view = presentOwnerlessTreasury({ inspection: live(), decisions: [], decisionsLoaded: true, fundingLogsRead: true });
    expect(view.fundingReady).toBe(true);
    expect(view.fundingAddress).toBe(BANK);
    expect(view.explorerContractHref).toBe(`https://monadscan.com/address/${BANK.toLowerCase()}`);
    expect(view.deploymentTxHref).toBeNull();
    expect(view.sourceVerified).toBe(false);
    expect(view.sourceNote).toContain("not checked");
    expect(view.monText).toContain("2");
    expect(view.chogText).toContain("5");
    expect(view.authorizerStatus).toContain("privileged spending authority");
    expect(view.execution).toContain("does not sign");
    expect(view.policy.join(" ")).toContain("application review limits");
  });

  it("links a deployment transaction only after that receipt is marked as creating the checked contract", () => {
    const hash = `0x${"12".repeat(32)}`;
    const unverified = presentOwnerlessTreasury({
      inspection: live({ deploymentTx: hash, deploymentTxVerified: false }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(unverified.fundingReady).toBe(true);
    expect(unverified.deploymentTxHref).toBeNull();
    expect(unverified.warnings.join(" ")).toContain("not linked");

    const verified = presentOwnerlessTreasury({
      inspection: live({ deploymentTx: hash, deploymentTxVerified: true }),
      decisions: [],
      decisionsLoaded: true,
    });
    expect(verified.deploymentTxHref).toBe(`https://monadscan.com/tx/${hash}`);

    const claimed = presentOwnerlessTreasury({
      inspection: { ...pendingInspection(143), deploymentTx: hash, deploymentTxVerified: true },
      decisions: [],
      decisionsLoaded: true,
    });
    expect(claimed.fundingReady).toBe(false);
    expect(claimed.deploymentTxHref).toBeNull();
  });

  it("links only a confirmed on-chain payout and keeps a proposed hash off the explorer", () => {
    const proposed = presentOwnerlessTreasury({
      inspection: live(),
      decisionsLoaded: true,
      decisions: [
        {
          id: "proposal-1",
          status: "proposed",
          rationale: "Fare for the east road.",
          createdAt: "2026-10-21T00:00:00.000Z",
          output: {
            stage: "proposed",
            tokenId: "104",
            asset: "MON",
            amountRaw: "1000",
            reason: "Fare for the east road.",
            expectedOutcome: "One trip.",
            onchain: false,
            verified: false,
            txHash: HASH,
            chainId: 143,
            decisionId: DECISION,
          },
        },
      ],
    });
    expect(proposed.decisions[0]?.statusLabel).toBe("Proposed");
    expect(proposed.decisions[0]?.txHref).toBeNull();
    expect(proposed.decisions[0]?.txHash).toBeNull();

    const chain: VerifiedDistribution = {
      decisionId: DECISION,
      tokenId: "104",
      recipient: getAddress("0x3333333333333333333333333333333333333333"),
      asset: "MON",
      amountRaw: "1000",
      txHash: HASH,
      blockNumber: "42",
    };
    const confirmed = presentOwnerlessTreasury({
      inspection: live(),
      decisionsLoaded: true,
      distributions: [chain],
      decisions: proposed.decisions.length
        ? [
            {
              id: "proposal-1",
              status: "proposed",
              rationale: "Fare for the east road.",
              createdAt: null,
              output: { stage: "proposed", decisionId: DECISION, reason: "Fare for the east road.", tokenId: "104" },
            },
          ]
        : [],
    });
    expect(confirmed.decisions).toHaveLength(1);
    expect(confirmed.decisions[0]?.statusLabel).toBe("Confirmed");
    expect(confirmed.decisions[0]?.txHref).toBe(`https://monadscan.com/tx/${HASH}`);
    expect(confirmed.decisions[0]?.recipient?.toLowerCase()).toContain("3333");
    expect(confirmed.decisions[0]?.detail).toContain("Distributed event");
  });

  it("does not treat an unloaded decision query as an empty history", () => {
    const view = presentOwnerlessTreasury({ inspection: pendingInspection(143), decisions: [], decisionsLoaded: false });
    expect(view.decisionsNote).toContain("not loaded");
  });
});

describe("treasury log decoding", () => {
  it("reads Funded and Distributed events and collapses a duplicate token transfer", () => {
    const word = (value: string) => `0x${value.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;
    const fundedTopic = keccak256(toBytes("Funded(address,address,uint256)"));
    const decoded = decodeBankLog({
      data: encodeAbiParameters([{ type: "uint256" }], [5n]),
      topics: [fundedTopic, word(AUTHORIZER), word("0x0000000000000000000000000000000000000000")],
      transactionHash: HASH as Hex,
      blockNumber: 9n,
      logIndex: 1,
    });
    expect(decoded).toMatchObject({ asset: "MON", amountRaw: "5", kind: "funded_event" });

    const distributedTopic = keccak256(toBytes("Distributed(bytes32,uint256,address,address,uint256,uint256,bytes32)"));
    const payout = decodeBankLog({
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [addresses.chogToken, 7n, 1n, `0x${"12".repeat(32)}`],
      ),
      topics: [distributedTopic, DECISION as Hex, toHex(104n, { size: 32 }), word("0x3333333333333333333333333333333333333333")],
      transactionHash: HASH as Hex,
      blockNumber: 9n,
      logIndex: 2,
    });
    expect(payout).toMatchObject({ tokenId: "104", amountRaw: "7", asset: "CHOG" });

    const collapsed = withoutFundedTransfers([
      { txHash: HASH, blockNumber: "9", logIndex: 0, from: AUTHORIZER, asset: "CHOG", amountRaw: "7", kind: "funded_event" },
      { txHash: HASH, blockNumber: "9", logIndex: 1, from: AUTHORIZER, asset: "CHOG", amountRaw: "7", kind: "direct_chog_transfer" },
      { txHash: `0x${"ef".repeat(32)}`, blockNumber: "8", logIndex: 0, from: AUTHORIZER, asset: "CHOG", amountRaw: "1", kind: "direct_chog_transfer" },
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.some((row) => row.kind === "direct_chog_transfer" && row.txHash === HASH)).toBe(false);
  });
});
