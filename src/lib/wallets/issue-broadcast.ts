import { getAddress, type Address, type Hex } from "viem";
import { decisionMatchesToken, lowestIssuerFees, matchAccountCreated, type AccountLog } from "@/lib/wallets/issuer";

/** One hour. The factory accepts a deadline up to one day ahead. */
export const ISSUANCE_TTL_SECONDS = 3600n;
/** One citizen-wallet creation on the current base fee. Observed wallets spend nothing. */
export const FEE_PER_WALLET_WEI = 50_000_000_000_000_000n;
export const SECRETS_URL = "https://github.com/jericddd/chogOS/settings/secrets/actions";
export const DEFAULT_ISSUANCE_URL = "https://chogos.vercel.app/api/wallets/issuance";

export function missingIssuerExitCode(eventName: string | undefined): 0 | 1 {
  return eventName === "schedule" ? 0 : 1;
}

/** Strip key material from a log line. Short strings are left alone so a normal sentence survives. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 16) continue;
    out = out.split(trimmed).join("[redacted]");
    const bare = trimmed.replace(/^0x/i, "");
    if (bare.length >= 16 && bare !== trimmed) out = out.split(bare).join("[redacted]");
  }
  return out;
}

/** Turn the mind runner URL into the wallet issuance URL on the same host. */
export function issuanceEndpoint(runnerUrl: string | undefined): string {
  if (!runnerUrl?.trim()) return DEFAULT_ISSUANCE_URL;
  let url: URL;
  try {
    url = new URL(runnerUrl.trim());
  } catch {
    return DEFAULT_ISSUANCE_URL;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return DEFAULT_ISSUANCE_URL;
  url.pathname = "/api/wallets/issuance";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type PendingDecision = { tokenId: string; decisionId: Hex };

export type IssueResult = { issued: number; observed: number; failed: number };

export type IssueIO = {
  factory: Address;
  agent: Address;
  gas: Address;
  chainId: () => Promise<number>;
  factoryAgent: (factory: Address) => Promise<Address>;
  predict: (factory: Address, tokenId: bigint) => Promise<Address>;
  bytecode: (address: Address) => Promise<Hex | undefined>;
  baseFee: () => Promise<bigint>;
  balance: () => Promise<bigint>;
  now: () => Promise<bigint>;
  sign: (factory: Address, tokenId: bigint, decisionId: Hex, deadline: bigint) => Promise<Hex>;
  sendCreate: (input: {
    factory: Address;
    tokenId: bigint;
    decisionId: Hex;
    deadline: bigint;
    signature: Hex;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: 1n;
  }) => Promise<Hex>;
  receipt: (hash: Hex) => Promise<{ status: "success" | "reverted"; logs: readonly AccountLog[] }>;
  confirm: (body: { decisionId: Hex; txHash?: Hex; observed?: true }) => Promise<{ ok: true } | { ok: false; error: string }>;
  log: (line: string) => void;
};

/**
 * Link each pending decision to a citizen wallet.
 * Existing code is recorded without a new transaction.
 * A missing wallet is created with factory create. No other contract call is made.
 */
export async function issuePendingDecisions(decisions: readonly PendingDecision[], io: IssueIO): Promise<IssueResult> {
  if (getAddress(io.agent) === getAddress(io.gas)) {
    throw new Error("The agent address and the gas address are the same. Nothing was signed.");
  }
  if (decisions.length === 0) return { issued: 0, observed: 0, failed: 0 };
  const chainId = await io.chainId();
  if (chainId !== 143) throw new Error(`Wallet issuance stopped because the RPC chain is ${chainId}. Nothing was signed.`);
  const onchainAgent = getAddress(await io.factoryAgent(io.factory));
  if (onchainAgent !== getAddress(io.agent)) {
    throw new Error("The factory agent does not match the issuer agent. Nothing was signed.");
  }
  let issued = 0;
  let observed = 0;
  let failed = 0;
  for (const decision of decisions) {
    try {
      if (!decisionMatchesToken(decision.tokenId, decision.decisionId)) {
        throw new Error(`Decision ${decision.decisionId} does not belong to token ${decision.tokenId}.`);
      }
      const tokenId = BigInt(decision.tokenId);
      const predicted = await io.predict(io.factory, tokenId);
      const code = await io.bytecode(predicted);
      if (code && code !== "0x") {
        const saved = await io.confirm({ decisionId: decision.decisionId, observed: true });
        if (!saved.ok) throw new Error(saved.error);
        io.log(`Token ${decision.tokenId} already has wallet ${predicted}. The decision is linked without a new transaction.`);
        observed += 1;
        continue;
      }
      const balance = await io.balance();
      if (balance < FEE_PER_WALLET_WEI) {
        throw new Error(`Gas wallet ${getAddress(io.gas)} has ${balance} wei, short of ${FEE_PER_WALLET_WEI} wei for this wallet. Nothing further was signed.`);
      }
      const now = await io.now();
      const deadline = now + ISSUANCE_TTL_SECONDS;
      if (deadline <= now || deadline > now + 86_400n) throw new Error(`Token ${decision.tokenId} deadline is outside the factory window.`);
      const signature = await io.sign(io.factory, tokenId, decision.decisionId, deadline);
      const fees = lowestIssuerFees(await io.baseFee());
      const hash = await io.sendCreate({
        factory: io.factory,
        tokenId,
        decisionId: decision.decisionId,
        deadline,
        signature,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const mined = await io.receipt(hash);
      if (mined.status !== "success") throw new Error(`Token ${decision.tokenId} transaction ${hash} reverted.`);
      const created = matchAccountCreated(mined.logs, { factory: io.factory, tokenId, decisionId: decision.decisionId });
      if (created) {
        const saved = await io.confirm({ decisionId: decision.decisionId, txHash: hash });
        if (!saved.ok) throw new Error(saved.error);
        io.log(`Token ${decision.tokenId} wallet ${created.account} created in ${hash}.`);
        issued += 1;
        continue;
      }
      const after = await io.bytecode(predicted);
      if (after && after !== "0x") {
        const saved = await io.confirm({ decisionId: decision.decisionId, observed: true });
        if (!saved.ok) throw new Error(saved.error);
        io.log(`Token ${decision.tokenId} wallet ${predicted} was already on Monad. Decision linked without treating ${hash} as the creation.`);
        observed += 1;
        continue;
      }
      throw new Error(`Token ${decision.tokenId} transaction ${hash} did not create the wallet.`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Wallet issuance failed.";
      io.log(message.slice(0, 500));
      break;
    }
  }
  return { issued, observed, failed };
}
