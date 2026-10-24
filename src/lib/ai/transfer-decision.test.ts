import { describe, expect, it } from "vitest";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import {
  assembleTransferWorld,
  blockingTransferReason,
  CHOG_ASSET_LIMIT,
  CITIZEN_CONTRIBUTION_LIMIT,
  CITIZEN_TRANSFER_LIMIT,
  classifyTransferReceipt,
  nftHolderAuthorizesSpend,
  settleTransferText,
  transferMessages,
  type TransferCitizen,
  type TransferWorld,
} from "@/lib/ai/transfer-decision";

const BANK = MAINNET_CHOG_BANK;
const WALLET_A = "0x238797c75Ad0423516F84D917B7A9d765831bf02";
const WALLET_B = "0x1111111111111111111111111111111111111111";

function citizen(patch: Partial<TransferCitizen> & Pick<TransferCitizen, "tokenId" | "citizenId">): TransferCitizen {
  return {
    name: `Chog #${patch.tokenId}`,
    wallet: WALLET_A,
    role: "builder",
    activity: "working",
    workId: "road-east",
    goal: "Finish the east road",
    monBalanceRaw: "2000000000000000",
    ...patch,
  };
}

function world(patch: Partial<Parameters<typeof assembleTransferWorld>[0]> = {}): TransferWorld {
  return assembleTransferWorld({
    citizens: [
      citizen({ tokenId: "7", citizenId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", wallet: WALLET_A }),
      citizen({
        tokenId: "104",
        citizenId: "cccccccc-dddd-4eee-8fff-000000000000",
        wallet: WALLET_B,
        role: "crafter",
        activity: "working",
        workId: "workshop",
        goal: "Make tools",
        monBalanceRaw: "5000000000000000",
      }),
    ],
    needs: [{ needType: "food_shortage", status: "active", stock: { food: 12 } }],
    projects: [
      {
        id: "11111111-2222-4333-8444-555555555555",
        name: "East road",
        status: "active",
        projectType: "territorial",
        justification: "The east road is still incomplete.",
      },
    ],
    events: [{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", kind: "work.shift_completed", summary: "Chog #104 finished a shift.", tokenId: "104" }],
    priors: [],
    ...patch,
  });
}

function proposal(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    direction: "citizen_to_citizen",
    action: "pay_for_work",
    senderTokenId: "7",
    recipientTokenId: "104",
    amountRaw: "1000000000000000",
    asset: "MON",
    explanation: "Pay the crafter for the stored shift.",
    factIds: ["citizen:104:work", "event:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
    prerequisites: ["The shift is already stored."],
    ...patch,
  });
}

describe("three-way economic proposals", () => {
  it("shows the model only stored facts and no addresses", () => {
    const snapshot = world();
    const messages = transferMessages(snapshot);
    expect(messages.user).toContain("food_shortage");
    expect(messages.user).toContain("East road");
    expect(messages.user).toContain("Finish the east road");
    expect(messages.user).toContain("2000000000000000");
    expect(messages.user).not.toContain(WALLET_A);
    expect(messages.user).not.toContain(BANK);
    expect(messages.system).toContain("does not sign");
    expect(blockingTransferReason(snapshot)).toBeNull();
  });

  it("proposes a citizen-to-citizen payment without executing it", () => {
    const settled = settleTransferText(proposal(), world());
    expect(settled.publicState).toBe("proposed");
    expect(settled.direction).toBe("citizen_to_citizen");
    expect(settled.executable).toBe(false);
    expect(settled.amountRaw).toBe("1000000000000000");
    expect(settled.rationale).toContain("Chog #7");
    expect(settled.rationale).toContain("Chog #104");
    expect(settled.rationale).toContain("finished a shift");
    expect(settled.rationale).toContain(CITIZEN_TRANSFER_LIMIT);
    expect(settled.rationale).not.toMatch(/confirmed|was paid|transaction succeeded/i);
    expect(settled.wallet).toBe(WALLET_A);
    expect(settled.recipientWallet).toBe(WALLET_B);
  });

  it("proposes a voluntary ChogBank contribution and pins the bank", () => {
    const settled = settleTransferText(
      proposal({
        direction: "citizen_to_chogbank",
        action: "fund_project",
        recipientTokenId: "104",
        factIds: ["project:11111111-2222-4333-8444-555555555555"],
        explanation: "Fund the east road.",
      }),
      world(),
    );
    expect(settled.publicState).toBe("proposed");
    expect(settled.direction).toBe("citizen_to_chogbank");
    expect(settled.purpose).toBe("citizen_return");
    expect(settled.recipientWallet).toBe(BANK);
    expect(settled.executable).toBe(false);
    expect(settled.limitation).toBe(CITIZEN_CONTRIBUTION_LIMIT);
    expect(settled.rationale).toMatch(/voluntary/i);
    expect(settled.rationale).toMatch(/No tax rule is stored/);
  });

  it("defers a ChogBank payout from this review instead of creating one", () => {
    const settled = settleTransferText(proposal({ direction: "chogbank_to_citizen", action: "payout" }), world());
    expect(settled.publicState).toBe("deferred");
    expect(settled.executable).toBe(false);
    expect(settled.amountRaw).toBeNull();
    expect(settled.rationale).toMatch(/treasury review/i);
  });

  it("defers when the balance, the recipient, or the supporting fact is missing", () => {
    const unread = world({
      citizens: [citizen({ tokenId: "7", citizenId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", monBalanceRaw: null })],
    });
    expect(blockingTransferReason(unread)).toMatch(/balances were not read/i);
    expect(settleTransferText(proposal(), unread).record).toBe(true);
    expect(settleTransferText(proposal(), unread).publicState).toBe("deferred");

    const missingRecipient = settleTransferText(proposal({ recipientTokenId: "999" }), world());
    expect(missingRecipient.publicState).toBe("deferred");
    expect(missingRecipient.rationale).toMatch(/not a citizen/i);

    const purchase = settleTransferText(proposal({ action: "buy_goods", factIds: ["citizen:104:work"] }), world());
    expect(purchase.publicState).toBe("deferred");
    expect(purchase.rationale).toMatch(/No purchase was recorded/i);

    const poor = settleTransferText(proposal({ amountRaw: "9000000000000000" }), world());
    expect(poor.publicState).toBe("deferred");
    expect(poor.rationale).toMatch(/below/i);
  });

  it("does not record a second copy of the same proposal", () => {
    const first = settleTransferText(proposal(), world());
    const again = settleTransferText(
      proposal(),
      world({
        priors: [
          {
            key: first.idempotencyKey,
            direction: "citizen_to_citizen",
            senderTokenId: "7",
            publicState: "proposed",
          },
        ],
      }),
    );
    expect(again.record).toBe(false);
    expect(again.executable).toBe(false);
    expect(again.rationale).toMatch(/already recorded/i);
  });

  it("keeps an unreadable reply and a refusal distinct from a payment", () => {
    const broken = settleTransferText("send the money", world());
    expect(broken.publicState).toBe("technical_failure");
    expect(broken.amountRaw).toBeNull();
    expect(broken.rationale).toMatch(/not JSON/i);
    const none = settleTransferText(JSON.stringify({ direction: "none", explanation: "Nobody needs a transfer." }), world());
    expect(none.publicState).toBe("no_allocation");
    expect(none.amountRaw).toBeNull();
    const repeat = settleTransferText("send the money", world({ priors: [{ key: broken.idempotencyKey, direction: "", senderTokenId: null, publicState: "technical_failure" }] }));
    expect(repeat.record).toBe(false);
  });

  it("rejects $CHOG, NFT-holder authority, and a bank address that is not the deployment", () => {
    const chog = settleTransferText(proposal({ asset: "CHOG" }), world());
    expect(chog.publicState).toBe("deferred");
    expect(chog.rationale).toBe(CHOG_ASSET_LIMIT);
    const holder = settleTransferText(proposal({ owner: WALLET_A }), world());
    expect(holder.publicState).toBe("technical_failure");
    expect(holder.rationale).toMatch(/NFT holder cannot authorize/i);
    expect(nftHolderAuthorizesSpend({
      scheme: "ai_issued_v3",
      agentBefore: "0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04",
      agentAfter: "0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04",
    })).toBe(false);
    expect(nftHolderAuthorizesSpend({
      scheme: "ai_issued_v3",
      agentBefore: "0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04",
      agentAfter: "0x1111111111111111111111111111111111111111",
    })).toBe(true);
  });

  it("confirms a transfer only when the receipt matches the proposal", () => {
    const expected = { asset: "MON" as const, amountRaw: "1000", sender: WALLET_A, recipient: WALLET_B };
    expect(classifyTransferReceipt({
      expected,
      receipt: {
        chainId: 143,
        txHash: `0x${"ab".repeat(32)}`,
        status: "success",
        sender: WALLET_A,
        recipient: WALLET_B,
        amountRaw: "1000",
        asset: "MON",
        logMatched: true,
      },
    })).toBe("confirmed");
    expect(classifyTransferReceipt({
      expected,
      receipt: {
        chainId: 143,
        txHash: `0x${"ab".repeat(32)}`,
        status: "success",
        sender: WALLET_A,
        recipient: WALLET_B,
        amountRaw: "1001",
        asset: "MON",
        logMatched: true,
      },
    })).toBe("failed_execution");
    expect(classifyTransferReceipt({
      expected,
      receipt: {
        chainId: 143,
        txHash: `0x${"ab".repeat(32)}`,
        status: "success",
        sender: BANK,
        recipient: WALLET_B,
        amountRaw: "1000",
        asset: "MON",
        logMatched: false,
      },
    })).toBe("failed_execution");
    expect(classifyTransferReceipt({
      expected,
      receipt: {
        chainId: 143,
        txHash: `0x${"ab".repeat(32)}`,
        status: "unknown",
        sender: null,
        recipient: null,
        amountRaw: null,
        asset: null,
        logMatched: false,
      },
    })).toBe("submitted_pending");
    expect(classifyTransferReceipt({
      expected,
      receipt: {
        chainId: 143,
        txHash: `0x${"ab".repeat(32)}`,
        status: "reverted",
        sender: WALLET_A,
        recipient: WALLET_B,
        amountRaw: "1000",
        asset: "MON",
        logMatched: true,
      },
    })).toBe("failed_execution");
    expect(classifyTransferReceipt({ expected, receipt: null })).toBe("not_confirmed");
  });
});
