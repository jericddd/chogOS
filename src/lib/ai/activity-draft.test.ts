import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { activityDrafts, publishDecisionActivity, type ActivityDecision } from "@/lib/ai/activity-event";
import type { SupabaseClient } from "@supabase/supabase-js";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CITIZEN = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const TX = `0x${"cd".repeat(32)}`;
const WALLET = "0x238797c75Ad0423516F84D917B7A9d765831bf02";

function decision(patch: Partial<ActivityDecision> & Pick<ActivityDecision, "purpose" | "status" | "output">): ActivityDecision {
  return {
    id: ID,
    citizenId: CITIZEN,
    rationale: "Because the town needs it.",
    ...patch,
  };
}

describe("activity drafts", () => {
  it("records a wallet decision without a transaction, then a confirmed creation when a receipt exists", () => {
    const proposed = activityDrafts(decision({
      purpose: "wallet_issuance",
      status: "proposed",
      output: { choice: "issue", tokenId: "104", verified: false, onchain: false, txHash: null },
    }));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ kind: "wallet.decided", chainStatus: "offchain", txHash: null, chainId: null });

    const created = activityDrafts(decision({
      purpose: "wallet_issuance",
      status: "executed",
      output: { choice: "issue", tokenId: "104", verified: true, onchain: true, address: WALLET, txHash: TX, blockNumber: "115600416" },
    }));
    expect(created.map((draft) => draft.kind)).toEqual(["wallet.decided", "wallet.created"]);
    expect(created[1]).toMatchObject({ chainStatus: "confirmed", chainId: 143, txHash: TX, outcome: "prefer" });
    expect(created[1]?.payload.broadcast).toBe(true);
    expect(created[1]?.payload.walletVerified).toBe(true);
  });

  it("confirms an observed wallet without storing a transaction hash", () => {
    const drafts = activityDrafts(decision({
      purpose: "wallet_issuance",
      status: "executed",
      output: { choice: "issue", tokenId: "104", verified: true, onchain: true, address: WALLET, txHash: null, blockNumber: null },
    }));
    expect(drafts[1]).toMatchObject({ kind: "wallet.created", chainStatus: "offchain", txHash: null, chainId: null });
    expect(drafts[1]?.summary).toMatch(/did not broadcast/i);
  });

  it("keeps fund, trade, and return decisions offchain", () => {
    const funds = activityDrafts(decision({
      purpose: "treasury_allocation",
      status: "proposed",
      output: { tokenId: "7", asset: "MON", txHash: TX },
    }));
    const trade = activityDrafts(decision({
      purpose: "citizen_trade",
      status: "proposed",
      output: { tokenId: "104", wallet: WALLET, walletVerified: true },
    }));
    const returning = activityDrafts(decision({
      purpose: "citizen_return",
      status: "proposed",
      output: { tokenId: "104", wallet: WALLET, walletVerified: true },
    }));
    expect(funds[0]).toMatchObject({ kind: "treasury.allocation", chainStatus: "offchain", txHash: null });
    expect(funds[0]?.summary).toMatch(/send MON/);
    expect(funds[0]?.summary).toMatch(/No transaction was broadcast/);
    const unreadable = activityDrafts(decision({
      purpose: "treasury_allocation",
      status: "rejected",
      rationale: "The treasury proposal was not JSON.",
      output: { tokenId: null, txHash: null, executed: false, onchain: false },
    }));
    expect(unreadable[0]?.summary).toMatch(/could not be read/);
    expect(unreadable[0]?.summary).toMatch(/no citizen was paid/i);
    expect(unreadable[0]).toMatchObject({ kind: "treasury.allocation", chainStatus: "offchain", txHash: null });
    expect(unreadable.map((draft) => draft.kind)).toEqual(["treasury.allocation"]);
    expect(trade[0]?.summary).toMatch(/Proposed/);
    expect(trade[0]?.summary).toMatch(/not a completed purchase/i);
    expect(returning[0]?.summary).toMatch(/ChogBank/);
    expect(returning[0]?.summary).toMatch(/No transaction was broadcast/);
    expect(returning[0]?.summary).toMatch(/not a completed return/i);
    expect([funds[0], trade[0], returning[0]].every((draft) => draft?.chainStatus === "offchain" && draft.txHash === null)).toBe(true);
  });

  it("adds a confirmed payout row only after a verified ChogBank receipt", () => {
    const drafts = activityDrafts(decision({
      purpose: "treasury_allocation",
      status: "executed",
      output: {
        tokenId: "91",
        asset: "MON",
        amountRaw: "10000000000000000",
        requestedAmountRaw: "100000000000000000",
        verified: true,
        onchain: true,
        address: WALLET,
        txHash: TX,
        blockNumber: "115680000",
        reason: "The east road still needs fare.",
      },
    }));
    expect(drafts.map((draft) => draft.kind)).toEqual(["treasury.allocation", "treasury.paid"]);
    expect(drafts[0]).toMatchObject({ chainStatus: "offchain", txHash: null });
    expect(drafts[1]).toMatchObject({
      chainStatus: "confirmed",
      chainId: 143,
      txHash: TX,
      outcome: "prefer",
    });
    expect(drafts[1]?.summary).toMatch(/0\.01 MON/);
    expect(drafts[1]?.summary).toMatch(/cap limited/);
    expect(drafts[1]?.payload.broadcast).toBe(true);
    expect(drafts[1]?.payload.bank).toBe("0xB2494538433B2FA3167A723d32329cc22c3A59C1");
  });

  it("inserts one AI activity row and does not duplicate it", async () => {
    const events: Array<Record<string, unknown>> = [];
    const outcomes: string[] = [];
    const client = {
      from(table: string) {
        const state: {
          op: string;
          values: Record<string, unknown> | null;
          filters: Array<[string, unknown]>;
          single: boolean;
        } = { op: "select", values: null, filters: [], single: false };
        const run = async () => {
          if (table === "civilization_events" && state.op === "insert") {
            const row = state.values ?? {};
            if (events.some((event) => event.dedupe_key === row.dedupe_key)) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            const id = `evt-${events.length + 1}`;
            events.push({ ...row, id });
            return { data: { id }, error: null };
          }
          if (table === "civilization_events") {
            let rows = events;
            for (const [column, value] of state.filters) {
              rows = Array.isArray(value)
                ? rows.filter((row) => value.includes(row[column]))
                : rows.filter((row) => row[column] === value);
            }
            if (state.single) return { data: rows[0] ? { id: rows[0].id } : null, error: null };
            return { data: rows.map((row) => ({ id: row.id, dedupe_key: row.dedupe_key })), error: null };
          }
          outcomes.push(JSON.stringify(state.values));
          return { data: null, error: null };
        };
        const api = {
          insert(values: Record<string, unknown>) {
            state.op = "insert";
            state.values = values;
            return api;
          },
          update(values: Record<string, unknown>) {
            state.op = "update";
            state.values = values;
            return api;
          },
          select() {
            return api;
          },
          eq(column: string, value: unknown) {
            state.filters.push([column, value]);
            return api;
          },
          in(column: string, value: unknown) {
            state.filters.push([column, value]);
            return api;
          },
          is() {
            return api;
          },
          maybeSingle() {
            state.single = true;
            return run();
          },
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            return run().then(resolve, reject);
          },
        };
        return api;
      },
    };
    const row = decision({
      purpose: "wallet_issuance",
      status: "executed",
      output: { choice: "issue", tokenId: "104", verified: true, onchain: true, address: WALLET, txHash: TX, blockNumber: "12" },
    });
    await publishDecisionActivity(client as unknown as SupabaseClient, row);
    await publishDecisionActivity(client as unknown as SupabaseClient, row);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.source)).toEqual(["ai", "ai"]);
    expect(events.map((event) => event.category)).toEqual(["ai", "ai"]);
    expect(events[1]).toMatchObject({ chain_status: "confirmed", tx_hash: TX, decision_id: ID });
    expect(outcomes.at(-1)).toContain("evt-2");
  });

  it("keeps every transfer state truthful and does not confirm a citizen transfer without a matching receipt", () => {
    const awaiting = activityDrafts(decision({
      purpose: "treasury_allocation",
      status: "proposed",
      rationale: "Production signing is disabled.",
      output: {
        tokenId: "104",
        asset: "MON",
        publicState: "approved_awaiting_execution",
        reason: "Finish the east road.",
        txHash: TX,
      },
    }));
    expect(awaiting[0]?.summary).toMatch(/Approved and awaiting execution/);
    expect(awaiting[0]?.summary).toMatch(/Finish the east road/);
    expect(awaiting[0]?.summary).toMatch(/No transaction was broadcast/);
    expect(awaiting[0]).toMatchObject({ chainStatus: "offchain", txHash: null });
    expect(awaiting.map((draft) => draft.kind)).toEqual(["treasury.allocation"]);

    const deferred = activityDrafts(decision({
      purpose: "citizen_trade",
      status: "rejected",
      rationale: "Citizen MON balances were not read, so no citizen transfer was proposed.",
      output: { tokenId: "7", publicState: "deferred", direction: "citizen_to_citizen", txHash: TX, verified: true, onchain: true },
    }));
    expect(deferred[0]?.summary).toMatch(/Deferred/);
    expect(deferred[0]?.summary).toMatch(/No transaction was broadcast/);
    expect(deferred[0]).toMatchObject({ chainStatus: "offchain", txHash: null });

    const falseSuccess = activityDrafts(decision({
      purpose: "citizen_trade",
      status: "executed",
      rationale: "Pay for the shift.",
      output: {
        tokenId: "7",
        recipientTokenId: "104",
        publicState: "confirmed",
        direction: "citizen_to_citizen",
        amountRaw: "1000",
        asset: "MON",
        wallet: WALLET,
        walletVerified: true,
        recipientWallet: "0x1111111111111111111111111111111111111111",
        txHash: TX,
        verified: true,
        onchain: true,
        chainId: 143,
        receiptStatus: "success",
        logMatched: false,
      },
    }));
    expect(falseSuccess[0]?.summary).toMatch(/Failed during execution/);
    expect(falseSuccess[0]?.summary).not.toMatch(/Confirmed successful/);
    expect(falseSuccess[0]).toMatchObject({ chainStatus: "offchain", txHash: null });

    const confirmed = activityDrafts(decision({
      purpose: "citizen_return",
      status: "executed",
      rationale: "Voluntary project funding.",
      output: {
        tokenId: "7",
        publicState: "confirmed",
        direction: "citizen_to_chogbank",
        amountRaw: "1000",
        asset: "MON",
        wallet: WALLET,
        walletVerified: true,
        recipientWallet: "0xB2494538433B2FA3167A723d32329cc22c3A59C1",
        bank: "0xB2494538433B2FA3167A723d32329cc22c3A59C1",
        txHash: TX,
        chainId: 143,
        receiptStatus: "success",
        logMatched: true,
      },
    }));
    expect(confirmed[0]?.summary).toMatch(/Confirmed successful/);
    expect(confirmed[0]?.summary).toMatch(/ChogBank/);
    expect(confirmed[0]).toMatchObject({ chainStatus: "confirmed", chainId: 143, txHash: TX });
  });

  it("does not give the website a way to spend a citizen wallet", () => {
    const source = readFileSync("src/lib/ai/activity-event.ts", "utf8");
    const commerce = readFileSync("src/lib/ai/citizen-commerce.ts", "utf8");
    const database = readFileSync("src/lib/ai/citizen-commerce-db.ts", "utf8");
    const transfers = readFileSync("src/lib/ai/transfer-decision.ts", "utf8");
    expect(source).not.toMatch(/sendTransaction|signTypedData|privateKey/);
    expect(commerce).not.toMatch(/sendTransaction|signTypedData|privateKey|functionName/);
    expect(database).not.toMatch(/sendTransaction|signTypedData|privateKey|submitIntent/);
    expect(transfers).toContain("does not sign");
    expect(transfers).toContain("executable: false");
  });
});
