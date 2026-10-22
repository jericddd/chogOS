import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { MAINNET_WALLET_FACTORY } from "@/lib/wallets/issuer";
import { onchainEvidenceFromRow } from "@/lib/world/onchain-links";
import { toEvent } from "@/lib/world/rows";

const TX = `0x${"ab".repeat(32)}`;
const WALLET = "0x238797c75Ad0423516F84D917B7A9d765831bf02";

describe("onchain evidence", () => {
  it("links a confirmed wallet creation to the transaction, block, wallet, factory, and Genesis token", () => {
    const evidence = onchainEvidenceFromRow({
      kind: "wallet.created",
      chain_status: "confirmed",
      chain_id: 143,
      tx_hash: TX,
      payload: {
        tokenId: "104",
        factory: MAINNET_WALLET_FACTORY,
        genesis: addresses.chogGenesis,
        wallet: WALLET,
        walletVerified: true,
        broadcast: true,
        blockNumber: "115600416",
      },
    });
    expect(evidence?.title).toBe("Monad wallet creation");
    expect(evidence?.links.map((link) => link.label)).toEqual([
      "Transaction",
      "Block",
      "Citizen wallet",
      "Wallet factory",
      "Genesis token",
    ]);
    expect(evidence?.links[0]?.href).toBe(`https://monadscan.com/tx/${TX}`);
    expect(evidence?.links[1]?.href).toBe("https://monadscan.com/block/115600416");
    expect(evidence?.links[2]?.href).toBe(`https://monadscan.com/address/${WALLET.toLowerCase()}`);
    expect(evidence?.links[3]?.href).toBe(`https://monadscan.com/address/${MAINNET_WALLET_FACTORY.toLowerCase()}`);
    expect(evidence?.links[4]?.href).toBe(`https://monadscan.com/nft/${addresses.chogGenesis.toLowerCase()}/104`);
  });

  it("keeps an observed wallet on the address links and does not invent a transaction", () => {
    const evidence = onchainEvidenceFromRow({
      kind: "wallet.created",
      chain_status: "offchain",
      chain_id: null,
      tx_hash: null,
      payload: {
        tokenId: "104",
        factory: MAINNET_WALLET_FACTORY,
        genesis: addresses.chogGenesis,
        wallet: WALLET,
        walletVerified: true,
        broadcast: false,
        blockNumber: null,
      },
    });
    expect(evidence?.links.map((link) => link.label)).toEqual(["Citizen wallet", "Wallet factory", "Genesis token"]);
    expect(evidence?.note).toMatch(/did not broadcast/i);
  });

  it("drops a factory that is not the deployed factory and a wallet that was not verified", () => {
    const evidence = onchainEvidenceFromRow({
      kind: "wallet.decided",
      chain_status: "offchain",
      payload: {
        tokenId: "104",
        factory: "0x0000000000000000000000000000000000000001",
        genesis: addresses.chogGenesis,
        wallet: WALLET,
        walletVerified: false,
        broadcast: true,
      },
    });
    expect(evidence?.links.map((link) => link.label)).toEqual(["Genesis token"]);
  });

  it("links the official $CHOG token only on a send-funds row", () => {
    const evidence = onchainEvidenceFromRow({
      kind: "treasury.allocation",
      chain_status: "offchain",
      tx_hash: TX,
      payload: { tokenId: "7", asset: "CHOG", factory: MAINNET_WALLET_FACTORY, genesis: addresses.chogGenesis },
    });
    expect(evidence?.links.map((link) => link.label)).toEqual(["Wallet factory", "Genesis token", "$CHOG token"]);
    expect(evidence?.links.some((link) => link.label === "Transaction")).toBe(false);
  });

  it("puts those links on the activity row", () => {
    const event = toEvent({
      id: "evt",
      seq: 1,
      kind: "citizen.trade",
      category: "ai",
      source: "ai",
      summary: "The AI mind decided Chog #104 should trade. No transaction was broadcast.",
      occurred_at: "2026-10-22T00:00:00Z",
      world_s: null,
      tick_seq: null,
      building_id: null,
      chain_status: "offchain",
      tx_hash: null,
      payload: {
        tokenId: "104",
        factory: MAINNET_WALLET_FACTORY,
        genesis: addresses.chogGenesis,
        wallet: WALLET,
        walletVerified: true,
      },
    });
    expect(event.txUrl).toBeNull();
    expect(event.onchain?.links.map((link) => link.label)).toEqual(["Citizen wallet", "Wallet factory", "Genesis token"]);
  });
});
