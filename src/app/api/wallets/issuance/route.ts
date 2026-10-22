import { NextResponse } from "next/server";
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { addresses } from "@/lib/blockchain/addresses";
import { getChain } from "@/lib/blockchain/chains";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { decisionMatchesToken, factoryAbi, MAINNET_WALLET_FACTORY, matchAccountCreated, walletTokenAbi } from "@/lib/wallets/issuer";

export const maxDuration = 60;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RPC = "https://rpc.monad.xyz";

type StoredOutput = Record<string, unknown>;

function authorize(request: Request): NextResponse | null {
  const config = readAppConfig();
  const secrets = [config.aiRunnerSecret, config.cronSecret].filter((value): value is string => Boolean(value));
  if (secrets.length === 0) {
    return NextResponse.json({ ok: false, error: "The wallet issuer route is closed until AI_RUNNER_SECRET or CRON_SECRET is set." }, { status: 403 });
  }
  if (!secrets.some((secret) => bearerMatches(request.headers.get("authorization"), secret))) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`wallet-issuance:${clientKey(request)}`, 30)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  if (config.chainId !== 143) {
    return NextResponse.json({ ok: false, error: "Wallet issuance runs on Monad mainnet, chain 143." }, { status: 409 });
  }
  return null;
}

function factoryAddress(): Address {
  const configured = process.env.CHOG_WALLET_FACTORY_ADDRESS?.trim();
  if (configured && isAddress(configured)) return getAddress(configured);
  return MAINNET_WALLET_FACTORY;
}

function outputOf(value: unknown): StoredOutput {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StoredOutput) : {};
}

function pendingFrom(row: { id: string; citizen_id: string | null; output: unknown }): {
  id: string;
  citizenId: string | null;
  tokenId: string;
  decisionId: Hex;
} | null {
  const output = outputOf(row.output);
  if (output.choice !== "issue") return null;
  if (output.onchain === true || output.verified === true) return null;
  const tokenId = typeof output.tokenId === "string" || typeof output.tokenId === "number" ? String(output.tokenId).split(".")[0] : "";
  const decisionId = typeof output.decisionId === "string" ? output.decisionId : "";
  if (!decisionMatchesToken(tokenId, decisionId)) return null;
  if (typeof output.txHash === "string" && HASH.test(output.txHash)) return null;
  return { id: String(row.id), citizenId: row.citizen_id, tokenId, decisionId: decisionId.toLowerCase() as Hex };
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  const client = createServiceRoleClient();
  const { data, error } = await client
    .from("ai_decisions")
    .select("id, citizen_id, output")
    .eq("purpose", "wallet_issuance")
    .in("status", ["proposed", "accepted", "queued"])
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ ok: false, error: "Wallet decisions could not be read." }, { status: 502 });
  const seen = new Set<string>();
  const decisions = ((data ?? []) as Array<{ id: string; citizen_id: string | null; output: unknown }>)
    .map(pendingFrom)
    .filter((row): row is NonNullable<typeof row> => {
      if (row == null || seen.has(row.decisionId)) return false;
      seen.add(row.decisionId);
      return true;
    })
    .slice(0, 5);
  return NextResponse.json({ ok: true, factory: factoryAddress(), decisions });
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
  const observed = record.observed === true;
  if (!HASH.test(decisionId) || (txHash !== "" && !HASH.test(txHash)) || (txHash === "" && !observed)) {
    return NextResponse.json({ ok: false, error: "decisionId is required, with a txHash or observed:true." }, { status: 400 });
  }
  const client = createServiceRoleClient();
  const selected = await client
    .from("ai_decisions")
    .select("id, status, output, input_commitment")
    .eq("purpose", "wallet_issuance")
    .eq("input_commitment", decisionId)
    .in("status", ["proposed", "accepted", "queued", "executed"])
    .order("created_at", { ascending: true })
    .limit(5);
  let data = selected.data;
  let error = selected.error;
  if (!error && (data ?? []).length === 0) {
    const recent = await client
      .from("ai_decisions")
      .select("id, status, output, input_commitment")
      .eq("purpose", "wallet_issuance")
      .in("status", ["proposed", "accepted", "queued", "executed"])
      .order("created_at", { ascending: false })
      .limit(200);
    data = recent.data;
    error = recent.error;
  }
  if (error) return NextResponse.json({ ok: false, error: "Wallet decisions could not be read." }, { status: 502 });
  const rows = ((data ?? []) as Array<{ id: string; status: string; output: unknown }>).filter((row) => {
    const output = outputOf(row.output);
    return typeof output.decisionId === "string" && output.decisionId.toLowerCase() === decisionId && output.choice === "issue";
  });
  const match = rows.find((row) => {
    const output = outputOf(row.output);
    return output.onchain !== true || output.verified !== true;
  }) ?? rows[0];
  if (!match) return NextResponse.json({ ok: false, error: "No issue decision matches that id." }, { status: 404 });
  const output = outputOf(match.output);
  const tokenId = typeof output.tokenId === "string" || typeof output.tokenId === "number" ? String(output.tokenId).split(".")[0] : "";
  if (!decisionMatchesToken(tokenId, decisionId)) {
    return NextResponse.json({ ok: false, error: "The decision id does not belong to that token." }, { status: 409 });
  }
  if (output.onchain === true && output.verified === true) {
    return NextResponse.json({ ok: true, already: true, id: match.id });
  }
  const config = readAppConfig();
  const chain = createPublicClient({
    chain: getChain(143),
    transport: http(config.rpcUrl ?? RPC, { timeout: 20_000, retryCount: 0 }),
  });
  const factory = factoryAddress();
  const predicted = await chain.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "predict",
    args: [143n, addresses.chogGenesis, BigInt(tokenId)],
  });
  let account = predicted;
  let blockNumber: string | null = null;
  let storedTx: string | null = null;
  if (txHash) {
    const receipt = await chain.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") {
      return NextResponse.json({ ok: false, error: "The transaction receipt is not successful." }, { status: 409 });
    }
    const created = matchAccountCreated(receipt.logs, { factory, tokenId: BigInt(tokenId), decisionId: decisionId as Hex });
    if (!created) {
      return NextResponse.json({ ok: false, error: "The receipt has no AccountCreated log for this decision." }, { status: 409 });
    }
    account = created.account;
    blockNumber = receipt.blockNumber.toString(10);
    storedTx = txHash;
  } else {
    const code = await chain.getBytecode({ address: predicted });
    if (!code || code === "0x") {
      return NextResponse.json({ ok: false, error: "That citizen wallet has no code." }, { status: 409 });
    }
  }
  const token = await chain.readContract({ address: account, abi: walletTokenAbi, functionName: "token" });
  if (token[0] !== 143n || token[1].toLowerCase() !== addresses.chogGenesis.toLowerCase() || token[2] !== BigInt(tokenId)) {
    return NextResponse.json({ ok: false, error: "The wallet token does not match this citizen." }, { status: 409 });
  }
  const next = {
    ...output,
    executed: true,
    onchain: true,
    verified: true,
    stage: "executed",
    chainId: 143,
    txHash: storedTx,
    blockNumber,
    address: account,
  };
  const updated = await client
    .from("ai_decisions")
    .update({
      status: "executed",
      output: next,
      validation_result: storedTx
        ? "Monad receipt matched AccountCreated for this decision."
        : "Wallet code was already on Monad for this token. This confirmation did not broadcast.",
    })
    .eq("id", match.id)
    .eq("status", match.status)
    .select("id");
  if (updated.error) return NextResponse.json({ ok: false, error: "The decision was verified and was not saved." }, { status: 502 });
  if (!updated.data || updated.data.length === 0) {
    return NextResponse.json({ ok: false, error: "The decision changed before it could be saved." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, id: match.id, address: account, txHash: storedTx });
}
