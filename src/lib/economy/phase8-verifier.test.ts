import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { NFT, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

const TX = `0x${"ab".repeat(32)}`;
const OTHER_TX = `0x${"ef".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const OP_A = "33333333-3333-4333-8333-333333333331";
const OP_A_RETRY = "33333333-3333-4333-8333-333333333332";
const OP_B = "33333333-3333-4333-8333-333333333333";
const NOTE = "economy_note_receipt(text, text, text, integer, numeric, text, text)";
const SETTLE = "economy_settle_proposal(text, text)";
const JOURNAL = "economy_append_journal(jsonb)";
const HOLDS = "economy_try_holds(jsonb)";
const RELEASE = "economy_release_operation(uuid, uuid)";
const OPEN = "economy_open_proposal(jsonb)";
const STATUS = "economy_apply_status(text, text, text, text)";
const LEDGER = "economy_ledger_snapshot(timestamp with time zone)";
const LEGACY = "economy_try_hold(text, uuid, numeric, text, text, numeric, numeric)";

function payload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  throw new Error("expected a jsonb result");
}

async function queryAs(db: PGlite, role: string, sql: string, params: unknown[] = []) {
  if (!/^[a-z_]+$/.test(role)) {
    throw new Error("unexpected role");
  }
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    const result = await db.query<{ r: unknown }>(sql, params);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function call(db: PGlite, role: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const result = await queryAs(db, role, sql, params);
  return payload(result.rows[0]?.r);
}

async function expectDenied(db: PGlite, role: string, sql: string, params: unknown[] = []): Promise<void> {
  await expect(queryAs(db, role, sql, params)).rejects.toThrow(/permission denied/i);
}

function proposalRow(key: string, citizenId: string) {
  return {
    idempotencyKey: key,
    citizenId,
    nftContract: NFT,
    tokenId: "7",
    operation: "payment",
    objective: "Buy timber for the workshop",
    rationale: "The listed goal needs a payment for timber.",
    expectedOutcome: "Timber is delivered if a later receipt succeeds.",
    asset: "MON",
    amountRaw: "4",
    estimatedGasWei: "0",
    fundingRequestRaw: "4",
  };
}

function hold(key: string, proposalId: string, amount = "4", observed = "100") {
  return {
    key,
    proposalId,
    tokenId: "7",
    asset: "MON",
    bucket: "business_capital",
    amountRaw: amount,
    observedRaw: observed,
  };
}

function journalLines() {
  const key = `143:${TX}:receipt`;
  const line = (side: "debit" | "credit") => ({
    postingId: key,
    account: "external",
    asset: "MON",
    amountRaw: "1",
    side,
    kind: "receipt_observed",
    source: "chain",
    ref: key,
    status: "observed",
    evidenceKey: key,
  });
  return [line("debit"), line("credit")];
}

describe("economy verifier boundary", () => {
  it("lets the verifier settle a checked receipt and refuses service-role fabrication", async () => {
    const db = await openWorldDb();
    try {
      const allowed = async (sql: string) => (await rows<{ ok: boolean }>(db, `select ${sql} as ok`))[0]!.ok;
      expect(await allowed(`has_function_privilege('service_role', '${NOTE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('service_role', '${SETTLE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('service_role', '${JOURNAL}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('service_role', '${LEGACY}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('anon', '${NOTE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('authenticated', '${SETTLE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${NOTE}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${SETTLE}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${JOURNAL}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${HOLDS}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${RELEASE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${OPEN}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('service_role', '${HOLDS}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('service_role', '${RELEASE}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('service_role', '${OPEN}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('service_role', '${STATUS}', 'execute')`)).toBe(true);
      expect(await allowed(`has_function_privilege('service_role', '${LEDGER}', 'execute')`)).toBe(true);
      expect(await allowed("has_table_privilege('service_role', 'economy_proposals', 'select')")).toBe(true);
      expect(await allowed("has_table_privilege('service_role', 'economy_proposals', 'insert')")).toBe(false);
      expect(await allowed("has_table_privilege('service_role', 'economy_proposals', 'update')")).toBe(false);
      expect(await allowed("has_table_privilege('service_role', 'economy_reservations', 'update')")).toBe(false);
      expect(await allowed("has_table_privilege('service_role', 'economy_journal', 'insert')")).toBe(false);
      expect(await allowed("has_table_privilege('service_role', 'economy_proposal_audit', 'insert')")).toBe(false);
      expect(await allowed("has_table_privilege('chogos_economy_verifier', 'economy_journal', 'insert')")).toBe(false);
      expect(await allowed("has_table_privilege('chogos_economy_verifier', 'economy_journal', 'select')")).toBe(false);
      expect(await allowed("has_table_privilege('chogos_economy_verifier', 'economy_proposals', 'update')")).toBe(false);
      expect(await allowed("has_table_privilege('chogos_economy_verifier', 'economy_reservations', 'update')")).toBe(false);
      expect(await allowed("pg_has_role('service_role', 'chogos_economy_verifier', 'member')")).toBe(false);
      expect(await allowed("pg_has_role('anon', 'chogos_economy_verifier', 'member')")).toBe(false);
      expect(await allowed("pg_has_role('authenticated', 'chogos_economy_verifier', 'member')")).toBe(false);
      expect(await allowed("pg_has_role('authenticator', 'chogos_economy_verifier', 'member')")).toBe(true);

      const role = (await rows<{ rolbypassrls: boolean; rolcanlogin: boolean; rolinherit: boolean }>(
        db,
        "select rolbypassrls, rolcanlogin, rolinherit from pg_roles where rolname = 'chogos_economy_verifier'",
      ))[0]!;
      expect(role).toEqual({ rolbypassrls: false, rolcanlogin: false, rolinherit: false });
      const definers = await rows<{ proname: string; prosecdef: boolean }>(
        db,
        "select proname, prosecdef from pg_proc join pg_namespace n on n.oid = pronamespace where n.nspname = 'public' and proname in ('economy_note_receipt', 'economy_settle_proposal', 'economy_append_journal', 'economy_try_holds', 'economy_try_hold')",
      );
      expect(definers.find((item) => item.proname === "economy_note_receipt")?.prosecdef).toBe(true);
      expect(definers.find((item) => item.proname === "economy_settle_proposal")?.prosecdef).toBe(true);
      expect(definers.find((item) => item.proname === "economy_append_journal")?.prosecdef).toBe(true);
      expect(definers.find((item) => item.proname === "economy_try_holds")?.prosecdef).toBe(true);
      expect(definers.find((item) => item.proname === "economy_try_hold")?.prosecdef).toBe(false);

      await seedCitizens(db, 1);
      const citizenId = (await rows<{ id: string }>(db, "select id from citizens limit 1"))[0]!.id;
      const legacy = payload(
        (await db.query<{ r: unknown }>("select economy_try_hold($1, $2, 7, 'MON', 'business_capital', 4, 100) as r", ["legacy", citizenId])).rows[0]!.r,
      );
      expect(legacy).toMatchObject({ ok: false, outcome: "malformed" });
      expect(await rows<{ n: number }>(db, "select count(*)::int as n from economy_reservations")).toEqual([{ n: 0 }]);
      await expectDenied(db, "service_role", "select economy_try_hold($1, $2, 7, 'MON', 'business_capital', 4, 100) as r", ["legacy", citizenId]);
      await expectDenied(
        db,
        "service_role",
        "insert into economy_proposals (idempotency_key, chain_id, citizen_id, nft_contract, token_id, operation, objective, rationale, expected_outcome, asset, amount_raw, estimated_gas_wei, funding_request_raw, status, reason, expires_at) values ('direct', 143, $1, $2, 7, 'payment', 'Direct', 'Direct insert', 'Should fail', 'MON', 1, 0, 0, 'proposed', 'no', now() + interval '1 hour')",
        [citizenId, NFT],
      );
      await expect(
        db.query(
          "insert into economy_proposals (idempotency_key, chain_id, citizen_id, nft_contract, token_id, operation, objective, rationale, expected_outcome, asset, amount_raw, estimated_gas_wei, funding_request_raw, status, reason, expires_at) values ('direct-confirmed', 143, $1, $2, 7, 'payment', 'Direct', 'Direct insert', 'Should fail', 'MON', 1, 0, 0, 'confirmed', 'no', now() + interval '1 hour')",
          [citizenId, NFT],
        ),
      ).rejects.toThrow(/a proposal insert must start as proposed/i);

      const openedA = await call(db, "service_role", "select economy_open_proposal($1::jsonb) as r", [JSON.stringify(proposalRow("proposal-a", citizenId))]);
      const openedB = await call(db, "service_role", "select economy_open_proposal($1::jsonb) as r", [JSON.stringify(proposalRow("proposal-b", citizenId))]);
      expect(openedA.ok).toBe(true);
      expect(openedB.ok).toBe(true);
      const proposalA = String(openedA.id);
      const proposalB = String(openedB.id);

      const short = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_A, holds: [hold("short", proposalA, "50", "40")] }),
      ]);
      expect(short).toMatchObject({ ok: false, outcome: "insufficient_funds" });
      expect(await rows<{ n: number }>(db, "select count(*)::int as n from economy_reservations")).toEqual([{ n: 0 }]);

      const heldA = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_A, holds: [hold("hold-a", proposalA)] }),
      ]);
      expect(heldA).toMatchObject({ ok: true, created: true, operationId: OP_A });
      const replay = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_A_RETRY, holds: [hold("hold-a", proposalA)] }),
      ]);
      expect(replay).toMatchObject({ ok: true, created: false, operationId: OP_A_RETRY });
      expect(await rows<{ operation_id: string }>(db, "select operation_id from economy_reservations where idempotency_key = 'hold-a'")).toEqual([
        { operation_id: OP_A },
      ]);
      const crowded = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_B, holds: [hold("too-much", proposalA, "200", "100")] }),
      ]);
      expect(crowded).toMatchObject({ ok: false, outcome: "insufficient_funds" });
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-a'")).toEqual([{ state: "held" }]);

      const missed = await call(db, "service_role", "select economy_release_operation($1, $2) as r", [OP_B, proposalA]);
      expect(missed).toMatchObject({ ok: true, released: 0 });
      const released = await call(db, "service_role", "select economy_release_operation($1, $2) as r", [OP_A, proposalA]);
      expect(released).toMatchObject({ ok: true, released: 1 });
      const reheld = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_A_RETRY, holds: [hold("hold-a", proposalA)] }),
      ]);
      expect(reheld).toMatchObject({ ok: true, created: true });
      expect(await rows<{ operation_id: string; state: string }>(db, "select operation_id, state from economy_reservations where idempotency_key = 'hold-a'")).toEqual([
        { operation_id: OP_A_RETRY, state: "held" },
      ]);

      const heldB = await call(db, "service_role", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_B, holds: [hold("hold-b", proposalB)] }),
      ]);
      expect(heldB).toMatchObject({ ok: true, created: true });
      expect(await call(db, "service_role", "select economy_apply_status($1, 'approved', 'reserved') as r", ["proposal-a"])).toMatchObject({ ok: true, status: "approved" });
      expect(await call(db, "service_role", "select economy_apply_status($1, 'submitted', 'submitted') as r", ["proposal-a"])).toMatchObject({ ok: true, status: "submitted" });
      expect(await call(db, "service_role", "select economy_apply_status($1, 'approved', 'reserved') as r", ["proposal-b"])).toMatchObject({ ok: true, status: "approved" });
      expect(await call(db, "service_role", "select economy_apply_status($1, 'submitted', 'submitted') as r", ["proposal-b"])).toMatchObject({ ok: true, status: "submitted" });

      await expectDenied(db, "service_role", `select economy_note_receipt('proposal-a', 'forged', '${TX}', 143, 10, '${BLOCK}', 'reverted') as r`);
      const reverted = await call(db, "chogos_economy_verifier", "select economy_note_receipt($1, $2, $3, 143, 10, $4, 'reverted') as r", [
        "proposal-a",
        "The mainnet receipt reverted.",
        TX,
        BLOCK,
      ]);
      expect(reverted).toMatchObject({ ok: true, status: "reverted", duplicate: false });
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-a'")).toEqual([{ state: "released" }]);
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-b'")).toEqual([{ state: "held" }]);

      const confirmed = await call(db, "chogos_economy_verifier", "select economy_note_receipt($1, $2, $3, 143, 10, $4, 'success') as r", [
        "proposal-b",
        "The mainnet receipt succeeded.",
        TX,
        BLOCK,
      ]);
      expect(confirmed).toMatchObject({ ok: true, status: "confirmed", duplicate: false });
      const audits = await rows<{ n: number }>(db, "select count(*)::int as n from economy_proposal_audit where proposal_id = $1", [proposalB]);
      const duplicateNote = await call(db, "chogos_economy_verifier", "select economy_note_receipt($1, $2, $3, 143, 10, $4, 'success') as r", [
        "proposal-b",
        "The mainnet receipt succeeded.",
        TX,
        BLOCK,
      ]);
      expect(duplicateNote).toMatchObject({ ok: true, duplicate: true, status: "confirmed" });
      expect(await rows<{ n: number }>(db, "select count(*)::int as n from economy_proposal_audit where proposal_id = $1", [proposalB])).toEqual(audits);
      const conflict = await call(db, "chogos_economy_verifier", "select economy_note_receipt($1, $2, $3, 143, 10, $4, 'success') as r", [
        "proposal-b",
        "other",
        OTHER_TX,
        BLOCK,
      ]);
      expect(conflict).toMatchObject({ ok: false, outcome: "conflict" });
      expect(await rows<{ tx_hash: string; status: string }>(db, "select tx_hash, status from economy_proposals where id = $1", [proposalB])).toEqual([
        { tx_hash: TX, status: "confirmed" },
      ]);

      const early = await call(db, "chogos_economy_verifier", "select economy_settle_proposal($1, $2) as r", ["proposal-b", TX]);
      expect(early.ok).toBe(false);
      expect(String(early.reason)).toMatch(/journal/i);
      expect(await rows<{ status: string }>(db, "select status from economy_proposals where id = $1", [proposalB])).toEqual([{ status: "confirmed" }]);
      await expectDenied(db, "service_role", "select economy_append_journal($1::jsonb) as r", [JSON.stringify(journalLines())]);
      const posted = await call(db, "chogos_economy_verifier", "select economy_append_journal($1::jsonb) as r", [JSON.stringify(journalLines())]);
      expect(posted).toMatchObject({ ok: true, duplicate: false });
      const again = await call(db, "chogos_economy_verifier", "select economy_append_journal($1::jsonb) as r", [JSON.stringify(journalLines())]);
      expect(again).toMatchObject({ ok: true, duplicate: true });
      expect(await rows<{ n: number }>(db, "select count(*)::int as n from economy_journal")).toEqual([{ n: 2 }]);
      expect(await rows<{ account: string }>(db, "select distinct account from economy_journal")).toEqual([{ account: "external" }]);

      await expectDenied(db, "service_role", "select economy_settle_proposal($1, $2) as r", ["proposal-b", TX]);
      const settled = await call(db, "chogos_economy_verifier", "select economy_settle_proposal($1, $2) as r", ["proposal-b", TX]);
      expect(settled).toMatchObject({ ok: true, status: "settled", duplicate: false, executed: false });
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-b'")).toEqual([{ state: "reconciled" }]);
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-a'")).toEqual([{ state: "released" }]);
      const settledAgain = await call(db, "chogos_economy_verifier", "select economy_settle_proposal($1, $2) as r", ["proposal-b", TX]);
      expect(settledAgain).toMatchObject({ ok: true, duplicate: true, status: "settled" });
      const settledConflict = await call(db, "chogos_economy_verifier", "select economy_settle_proposal($1, $2) as r", ["proposal-b", OTHER_TX]);
      expect(settledConflict).toMatchObject({ ok: false, outcome: "conflict" });
      expect(await rows<{ tx_hash: string; status: string; executed: boolean }>(db, "select tx_hash, status, executed from economy_proposals where id = $1", [proposalB])).toEqual([
        { tx_hash: TX, status: "settled", executed: false },
      ]);

      await expectDenied(db, "service_role", "update economy_reservations set state = 'released' where idempotency_key = 'hold-b'");
      await expectDenied(db, "service_role", "update economy_proposals set receipt_status = 'reverted' where id = $1", [proposalB]);
      await expectDenied(
        db,
        "service_role",
        "insert into economy_journal (posting_id, account, asset, amount_raw, side, kind, source, ref, status, evidence_key) values ('forged', 'external', 'MON', 1, 'debit', 'receipt_observed', 'chain', 'forged', 'observed', '143:forged')",
      );
      await expectDenied(db, "chogos_economy_verifier", "update economy_reservations set state = 'released'");
      await expectDenied(db, "chogos_economy_verifier", "select economy_try_holds($1::jsonb) as r", [
        JSON.stringify({ operationId: OP_A, holds: [hold("verifier-hold", proposalA)] }),
      ]);
      await expectDenied(db, "anon", "select economy_note_receipt($1, $2, $3, 143, 10, $4, 'success') as r", ["proposal-b", "x", TX, BLOCK]);
      expect(await rows<{ state: string }>(db, "select state from economy_reservations where idempotency_key = 'hold-b'")).toEqual([{ state: "reconciled" }]);
      expect(await rows<{ n: number }>(db, "select count(*)::int as n from economy_journal")).toEqual([{ n: 2 }]);
      expect(await rows<{ execution_enabled: boolean }>(db, "select execution_enabled from economy_controls")).toEqual([{ execution_enabled: false }]);
      const ledger = await call(db, "service_role", "select economy_ledger_snapshot(now()) as r");
      expect(ledger.ok).toBe(true);
      await expectDenied(db, "chogos_economy_verifier", "select economy_ledger_snapshot(now()) as r");

      const before = await rows<{ proposals: number; reservations: number; journal: number }>(
        db,
        "select (select count(*)::int from economy_proposals) as proposals, (select count(*)::int from economy_reservations) as reservations, (select count(*)::int from economy_journal) as journal",
      );
      await db.exec(readFileSync(path.join(process.cwd(), "supabase/migrations/20261021000000_phase8_economy_verifier.sql"), "utf8"));
      expect(
        await rows<{ proposals: number; reservations: number; journal: number }>(
          db,
          "select (select count(*)::int from economy_proposals) as proposals, (select count(*)::int from economy_reservations) as reservations, (select count(*)::int from economy_journal) as journal",
        ),
      ).toEqual(before);
      expect(await allowed(`has_function_privilege('service_role', '${NOTE}', 'execute')`)).toBe(false);
      expect(await allowed(`has_function_privilege('chogos_economy_verifier', '${NOTE}', 'execute')`)).toBe(true);
      expect(await rows<{ tx_hash: string; status: string }>(db, "select tx_hash, status from economy_proposals where id = $1", [proposalB])).toEqual([
        { tx_hash: TX, status: "settled" },
      ]);
    } finally {
      await db.close();
    }
  }, 90_000);
});
