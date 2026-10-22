import { addresses } from "@/lib/blockchain/addresses";
import { explorerAddressUrl, explorerBlockUrl, explorerNftUrl, explorerTxUrl } from "@/lib/blockchain/explorer";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { MAINNET_WALLET_FACTORY } from "@/lib/wallets/issuer";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;
const KINDS = new Set(["wallet.decided", "wallet.created", "treasury.allocation", "treasury.paid", "citizen.trade", "citizen.return"]);

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
  if (kind === "treasury.paid") {
    return "Monad confirmed this ChogBank distribution. Open the transaction to read the receipt. The website did not sign it.";
  }
  return "The mind decided whether to send funds. This row has no Monad transaction.";
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
