import { NextResponse } from "next/server";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { publishDecisionActivity } from "@/lib/ai/activity-event";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { addresses } from "@/lib/blockchain/addresses";
import { getChain } from "@/lib/blockchain/chains";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import {
  acceptedPayout,
  bankAbi,
  bankSnapshotProblem,
  matchDistributed,
  pendingPayoutFromOutput,
  payoutReason,
  type BankSnapshot,
} from "@/lib/chogbank/payout";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import type { TreasuryAsset } from "@/lib/economy/treasury-policy";

export const maxDuration = 60;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RPC = "https://rpc.monad.xyz";

type StoredOutput = Record<string, unknown>;

function authorize(request: Request): NextResponse | null {
  const config = readAppConfig();
  const secrets = [config.aiRunnerSecret, config.cronSecret].filter((value): value is string => Boolean(value));
  if (secrets.length === 0) {
    return NextResponse.json({ ok: false, error: "The payout route is closed until AI_RUNNER_SECRET or CRON_SECRET is set." }, { status: 403 });
  }
  if (!secrets.some((secret) => bearerMatches(request.headers.get("authorization"), secret))) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`chogbank-payout:${clientKey(request)}`, 30)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  if (config.chainId !== 143) {
    return NextResponse.json({ ok: false, error: "ChogBank payouts run on Monad mainnet, chain 143." }, { status: 409 });
  }
  const url = new URL(request.url);
  if (url.search) {
    return NextResponse.json({ ok: false, error: "This route does not take query parameters." }, { status: 400 });
  }
  return null;
}

function outputOf(value: unknown): StoredOutput {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StoredOutput) : {};
}

function chainClient() {
  const config = readAppConfig();
  return createPublicClient({
    chain: getChain(143),
    transport: http(config.rpcUrl ?? RPC, { timeout: 20_000, retryCount: 0 }),
  });
}

async function readSnapshot(client: ReturnType<typeof chainClient>): Promise<BankSnapshot> {
  const bank = MAINNET_CHOG_BANK;
  const read = <
    T extends
      | "authorizer"
      | "configuredChainId"
      | "genesis"
      | "chogToken"
      | "windowSeconds"
      | "maxAuthorizationTtl"
      | "maxPerTxMon"
      | "maxCitizenWindowMon"
      | "maxAggregateWindowMon"
      | "maxPerTxChog"
      | "maxCitizenWindowChog"
      | "maxAggregateWindowChog",
  >(
    functionName: T,
  ) => client.readContract({ address: bank, abi: bankAbi, functionName });
  const [
    authorizer,
    chainId,
    genesis,
    chogToken,
    windowSeconds,
    maxAuthorizationTtl,
    maxPerTxMon,
    maxCitizenWindowMon,
    maxAggregateWindowMon,
    maxPerTxChog,
    maxCitizenWindowChog,
    maxAggregateWindowChog,
    monBalance,
    chogBalance,
  ] = await Promise.all([
    read("authorizer"),
    read("configuredChainId"),
    read("genesis"),
    read("chogToken"),
    read("windowSeconds"),
    read("maxAuthorizationTtl"),
    read("maxPerTxMon"),
    read("maxCitizenWindowMon"),
    read("maxAggregateWindowMon"),
    read("maxPerTxChog"),
    read("maxCitizenWindowChog"),
    read("maxAggregateWindowChog"),
    client.getBalance({ address: bank }),
    client.readContract({
      address: addresses.chogToken,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "balanceOf",
      args: [bank],
    }),
  ]);
  return {
    authorizer,
    chainId,
    genesis,
    chogToken,
    windowSeconds,
    maxAuthorizationTtl,
    maxPerTxMon,
    maxCitizenWindowMon,
    maxAggregateWindowMon,
    maxPerTxChog,
    maxCitizenWindowChog,
    maxAggregateWindowChog,
    monBalance,
    chogBalance,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  const client = createServiceRoleClient();
  const { data, error } = await client
    .from("ai_decisions")
    .select("id, output")
    .eq("purpose", "treasury_allocation")
    .in("status", ["proposed", "accepted", "queued"])
    .order("created_at", { ascending: true })
    .limit(40);
  if (error) return NextResponse.json({ ok: false, error: "Payout decisions could not be read." }, { status: 502 });
  const seen = new Set<string>();
  const decisions = ((data ?? []) as Array<{ output: unknown }>)
    .map((row) => pendingPayoutFromOutput(outputOf(row.output)))
    .filter((row): row is NonNullable<typeof row> => {
      if (row == null || seen.has(row.decisionId)) return false;
      seen.add(row.decisionId);
      return true;
    })
    .sort((left, right) => (left.asset === right.asset ? 0 : left.asset === "MON" ? -1 : 1))
    .slice(0, 8);
  const paid = await client
    .from("civilization_events")
    .select("tx_hash, payload")
    .eq("kind", "treasury.paid")
    .eq("source", "ai")
    .eq("chain_status", "confirmed")
    .order("seq", { ascending: false })
    .limit(20);
  const monDistributed =
    !paid.error &&
    ((paid.data ?? []) as Array<{ tx_hash?: string; payload?: unknown }>).some((row) => {
      const payload = outputOf(row.payload);
      return payload.asset === "MON" && typeof row.tx_hash === "string" && HASH.test(row.tx_hash);
    });
  return NextResponse.json({ ok: true, bank: MAINNET_CHOG_BANK, monDistributed, decisions });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "Expected an object." }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const decisionId = typeof record.decisionId === "string" ? record.decisionId.toLowerCase() : "";
  const txHash = typeof record.txHash === "string" ? record.txHash.toLowerCase() : "";
  if (!HASH.test(decisionId) || !HASH.test(txHash)) {
    return NextResponse.json({ ok: false, error: "decisionId and txHash are required." }, { status: 400 });
  }
  const client = createServiceRoleClient();
  const selected = await client
    .from("ai_decisions")
    .select("id, status, output, citizen_id, rationale")
    .eq("purpose", "treasury_allocation")
    .eq("input_commitment", decisionId)
    .in("status", ["proposed", "accepted", "queued", "executed"])
    .order("created_at", { ascending: true })
    .limit(5);
  let data = selected.data;
  let error = selected.error;
  if (!error && (data ?? []).length === 0) {
    const recent = await client
      .from("ai_decisions")
      .select("id, status, output, citizen_id, rationale")
      .eq("purpose", "treasury_allocation")
      .in("status", ["proposed", "accepted", "queued", "executed"])
      .order("created_at", { ascending: false })
      .limit(80);
    data = recent.data;
    error = recent.error;
  }
  if (error) return NextResponse.json({ ok: false, error: "Payout decisions could not be read." }, { status: 502 });
  const rows = ((data ?? []) as Array<{ id: string; status: string; output: unknown; citizen_id: string | null; rationale: string | null }>).filter((row) => {
    const output = outputOf(row.output);
    return typeof output.decisionId === "string" && output.decisionId.toLowerCase() === decisionId;
  });
  const match = rows.find((row) => {
    const output = outputOf(row.output);
    return output.onchain !== true || output.verified !== true;
  }) ?? rows[0];
  if (!match) return NextResponse.json({ ok: false, error: "No allocation matches that id." }, { status: 404 });
  const output = outputOf(match.output);
  if (output.onchain === true && output.verified === true) {
    await publishDecisionActivity(client, {
      id: match.id,
      citizenId: match.citizen_id,
      purpose: "treasury_allocation",
      status: "executed",
      rationale: match.rationale,
      output,
    });
    return NextResponse.json({ ok: true, already: true, id: match.id });
  }
  const pending = pendingPayoutFromOutput(output);
  if (!pending || pending.decisionId !== decisionId) {
    return NextResponse.json({ ok: false, error: "The stored allocation cannot be paid." }, { status: 409 });
  }
  const reason = payoutReason(output, match.rationale);
  if (!reason) return NextResponse.json({ ok: false, error: "The stored allocation has no payable reason." }, { status: 409 });
  let chain: ReturnType<typeof chainClient>;
  try {
    chain = chainClient();
    if ((await chain.getChainId()) !== 143) {
      return NextResponse.json({ ok: false, error: "The RPC chain is not 143." }, { status: 409 });
    }
    const snapshot = await readSnapshot(chain);
    const problem = bankSnapshotProblem(snapshot);
    if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 409 });
    const receipt = await chain.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success" || !receipt.to || getAddress(receipt.to) !== MAINNET_CHOG_BANK) {
      return NextResponse.json({ ok: false, error: "The transaction is not a successful ChogBank call." }, { status: 409 });
    }
    const log = matchDistributed(receipt.logs, { bank: MAINNET_CHOG_BANK, decisionId: decisionId as Hex });
    if (!log) return NextResponse.json({ ok: false, error: "The receipt has no Distributed log for this decision." }, { status: 409 });
    let recipient: Address;
    try {
      recipient = await chain.readContract({
        address: MAINNET_CHOG_BANK,
        abi: bankAbi,
        functionName: "payoutRecipient",
        args: [BigInt(pending.tokenId)],
      });
    } catch {
      return NextResponse.json({ ok: false, error: "That citizen wallet has no code." }, { status: 409 });
    }
    const accepted = acceptedPayout({
      stored: {
        decisionId: pending.decisionId,
        tokenId: pending.tokenId,
        asset: pending.asset as TreasuryAsset,
        amountRaw: BigInt(pending.amountRaw),
        reason,
      },
      log,
      recipient,
    });
    if (!accepted.ok) return NextResponse.json({ ok: false, error: accepted.reason }, { status: 409 });
    const next = {
      ...output,
      executed: true,
      onchain: true,
      verified: true,
      stage: "executed",
      chainId: 143,
      txHash,
      blockNumber: receipt.blockNumber.toString(10),
      address: recipient,
      amountRaw: accepted.amount.toString(10),
      requestedAmountRaw: pending.amountRaw,
      asset: pending.asset,
      reason,
    };
    const updated = await client
      .from("ai_decisions")
      .update({
        status: "executed",
        output: next,
        validation_result: "Monad receipt matched Distributed for this decision.",
      })
      .eq("id", match.id)
      .eq("status", match.status)
      .select("id");
    if (updated.error) return NextResponse.json({ ok: false, error: "The payout was verified and was not saved." }, { status: 502 });
    if (!updated.data || updated.data.length === 0) {
      return NextResponse.json({ ok: false, error: "The decision changed before it could be saved." }, { status: 409 });
    }
    await publishDecisionActivity(client, {
      id: match.id,
      citizenId: match.citizen_id,
      purpose: "treasury_allocation",
      status: "executed",
      rationale: match.rationale,
      output: next,
    });
    return NextResponse.json({ ok: true, id: match.id, txHash, amountRaw: accepted.amount.toString(10) });
  } catch {
    return NextResponse.json({ ok: false, error: "The payout receipt could not be read." }, { status: 502 });
  }
}
