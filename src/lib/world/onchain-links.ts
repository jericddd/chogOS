import { addresses } from "@/lib/blockchain/addresses";
import { explorerAddressUrl, explorerBlockUrl, explorerNftUrl, explorerTxUrl } from "@/lib/blockchain/explorer";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { MAINNET_WALLET_FACTORY } from "@/lib/wallets/issuer";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;
const KINDS = new Set([
  "wallet.decided",
  "wallet.created",
  "treasury.allocation",
  "treasury.paid",
  "citizen.trade",
  "citizen.return",
  "ai.decision",
  "ai.completed",
]);
const JOIN_KINDS = new Set(["genesis_joined", "citizen_enrolled", "citizen.joined_world"]);

export type OnchainLink = { label: string; href: string; value: string };

/** Direct Monadscan objects for an AI decision. Links are omitted when the stored fields do not match a pinned contract. */
export type OnchainEvidence = {
  title: string;
  note: string;
  links: OnchainLink[];
};

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && ADDRESS.test(left) && left.toLowerCase() === right.toLowerCase();
}

function titleFor(kind: string, broadcast: boolean): string {
  if (kind === "wallet.created") return broadcast ? "Monad wallet creation" : "Citizen wallet on Monad";
  if (kind === "wallet.decided") return "AI decision to create a wallet";
  if (kind === "treasury.paid") return "Monad ChogBank payout";
  if (kind === "treasury.allocation") return "AI decision to send funds";
  if (kind === "citizen.trade") return "AI decision to trade";
  if (kind === "ai.decision") return "AI decision, not yet carried out";
  if (kind === "ai.completed") return "Simulation carried out the decision";
  return "AI decision to return funds to ChogBank";
}

function defaultNote(kind: string, broadcast: boolean): string {
  if (kind === "wallet.created" && broadcast) {
    return "Open the transaction, block, citizen wallet, factory, and Genesis token on Monadscan. Opening a link does not replace reading the receipt.";
  }
  if (kind === "wallet.created") {
    return "This confirmation did not broadcast. The citizen wallet, factory, and Genesis token are on Monad. This row has no creation transaction.";
  }
  if (kind === "wallet.decided") {
    return "The mind decided to create this wallet. The wallet address is published on the creation row after Monad confirms it. No transaction is linked here.";
  }
  if (kind === "citizen.return") {
    return "The mind decided this citizen should return funds to ChogBank. This row has no return transaction.";
  }
  if (kind === "citizen.trade") {
    return "The mind decided this citizen should trade. This row has no Monad transaction.";
  }
  if (kind === "ai.decision") {
    return "The mind recorded this choice. The simulation has not carried it out on this row, and this row has no Monad transaction.";
  }
  if (kind === "ai.completed") {
    return "A world event confirmed this decision. This row is not an onchain transfer.";
  }
  if (kind === "treasury.paid") {
    return "Monad confirmed this ChogBank distribution. Open the transaction to read the receipt. The website did not sign it.";
  }
  return "The mind decided whether to send funds. This row has no Monad transaction.";
}

function joinTitle(kind: string): string {
  if (kind === "genesis_joined") return "Chog joined the founding roster";
  if (kind === "citizen_enrolled") return "Chog joined the civilization";
  return "Chog entered the world";
}

function joinNote(kind: string): string {
  if (kind === "citizen.joined_world") {
    return "This citizen was placed in the world after joining. Open the Genesis token on Monadscan. This row has no chain transaction.";
  }
  if (kind === "citizen_enrolled") {
    return "This row records the ownerOf read for the wallet that enrolled this Chog. Open the Genesis token, the observed owner, and the block. This row has no enrollment transaction.";
  }
  return "This row records the ownerOf read that admitted this Chog to the founding roster. Open the Genesis token, the observed owner, and the block. This row has no enrollment transaction.";
}

function evidenceChain(chainId: number | null | undefined): 143 | 10143 | null {
  if (chainId == null || chainId === 143) return 143;
  if (chainId === 10143) return 10143;
  return null;
}

/** Monadscan objects for a stored join. Enrollment is an ownerOf observation, so there is no transaction link. */
function joinEvidence(row: {
  kind: string;
  chain_id?: number | null;
  payload?: unknown;
}): OnchainEvidence | null {
  if (!JOIN_KINDS.has(row.kind)) return null;
  const payload = payloadRecord(row.payload);
  const chainId = evidenceChain(row.chain_id);
  const links: OnchainLink[] = [];
  const tokenId = typeof payload.tokenId === "string" || typeof payload.tokenId === "number" ? String(payload.tokenId).split(".")[0] : "";
  if (chainId != null && DECIMAL.test(tokenId)) {
    const href = explorerNftUrl(chainId, addresses.chogGenesis, tokenId);
    if (href) links.push({ label: "Genesis token", href, value: `${addresses.chogGenesis}/${tokenId}` });
  }
  const owner = typeof payload.owner === "string" ? payload.owner : "";
  if (chainId != null && ADDRESS.test(owner) && owner.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
    const href = explorerAddressUrl(chainId, owner);
    if (href) links.push({ label: "Observed owner", href, value: owner });
  }
  const block = typeof payload.blockNumber === "string" || typeof payload.blockNumber === "number" ? String(payload.blockNumber) : "";
  if (chainId != null && DECIMAL.test(block)) {
    const href = explorerBlockUrl(chainId, block);
    if (href) links.push({ label: "Block", href, value: block });
  }
  return { title: joinTitle(row.kind), note: joinNote(row.kind), links };
}

/**
 * Builds explorer links from a stored AI activity row.
 * A transaction link exists only when this row was inserted as a confirmed chain-143 receipt.
 */
export function onchainEvidenceFromRow(row: {
  kind: string;
  chain_status?: string | null;
  chain_id?: number | null;
  tx_hash?: string | null;
  payload?: unknown;
}): OnchainEvidence | null {
  const joined = joinEvidence(row);
  if (joined) return joined;
  if (!KINDS.has(row.kind)) return null;
  const payload = payloadRecord(row.payload);
  const broadcast = payload.broadcast === true && (row.kind === "wallet.created" || row.kind === "treasury.paid");
  const note = defaultNote(row.kind, broadcast);
  const links: OnchainLink[] = [];
  const tx = typeof row.tx_hash === "string" ? row.tx_hash : "";
  const confirmed = row.chain_status === "confirmed" && row.chain_id === 143 && HASH.test(tx);
  if (confirmed) {
    const href = explorerTxUrl(143, tx);
    if (href) links.push({ label: "Transaction", href, value: tx.toLowerCase() });
    const block = typeof payload.blockNumber === "string" || typeof payload.blockNumber === "number" ? String(payload.blockNumber) : "";
    const blockHref = DECIMAL.test(block) ? explorerBlockUrl(143, block) : null;
    if (blockHref) links.push({ label: "Block", href: blockHref, value: block });
  }
  if (sameAddress(payload.bank, MAINNET_CHOG_BANK) && (row.kind === "treasury.paid" || row.kind === "treasury.allocation")) {
    const href = explorerAddressUrl(143, MAINNET_CHOG_BANK);
    if (href) links.push({ label: "ChogBank", href, value: MAINNET_CHOG_BANK });
  }
  if (payload.walletVerified === true && typeof payload.wallet === "string" && ADDRESS.test(payload.wallet)) {
    const href = explorerAddressUrl(143, payload.wallet);
    if (href) links.push({ label: "Citizen wallet", href, value: payload.wallet });
  }
  if (sameAddress(payload.factory, MAINNET_WALLET_FACTORY)) {
    const href = explorerAddressUrl(143, MAINNET_WALLET_FACTORY);
    if (href) links.push({ label: "Wallet factory", href, value: MAINNET_WALLET_FACTORY });
  }
  const tokenId = typeof payload.tokenId === "string" || typeof payload.tokenId === "number" ? String(payload.tokenId).split(".")[0] : "";
  if (sameAddress(payload.genesis, addresses.chogGenesis) && DECIMAL.test(tokenId)) {
    const href = explorerNftUrl(143, addresses.chogGenesis, tokenId);
    if (href) links.push({ label: "Genesis token", href, value: `${addresses.chogGenesis}/${tokenId}` });
  }
  if (payload.asset === "CHOG" && (row.kind === "treasury.allocation" || row.kind === "treasury.paid")) {
    const href = explorerAddressUrl(143, addresses.chogToken);
    if (href) links.push({ label: "$CHOG token", href, value: addresses.chogToken });
  }
  return { title: titleFor(row.kind, broadcast), note, links };
}
