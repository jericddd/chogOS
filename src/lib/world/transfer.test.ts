import { describe, expect, it } from "vitest";
import { explorerTxUrl } from "@/lib/blockchain/explorer";
import { addresses } from "@/lib/blockchain/addresses";
import {
  TRANSFER_ISSUE,
  presentedAsMainnetGenesis,
  transferEvidenceFromRow,
  type TransferEvidence,
} from "@/lib/world/transfer";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"ff".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const WRONG = "0x3333333333333333333333333333333333333333";

function evidence(
  patch: {
    chain_status?: string | null;
    chain_id?: number | string | null;
    tx_hash?: string | null;
    canonical?: boolean | null;
  } = {},
  payload: Record<string, unknown> = {},
): TransferEvidence {
  const row = transferEvidenceFromRow({
    kind: "nft.transferred",
    chain_status: "confirmed",
    chain_id: 143,
    tx_hash: HASH,
    canonical: true,
    payload: {
      tokenId: "104",
      from: FROM,
      to: TO,
      blockNumber: "11",
      blockHash: BLOCK,
      logIndex: 4,
      contract: addresses.chogGenesis,
      ...payload,
    },
    ...patch,
  });
  if (!row) {
    throw new Error("expected a transfer");
  }
  return row;
}

describe("Chog Genesis mainnet transfer gate", () => {
  it("links a complete canonical mainnet log and no other row", () => {
    const row = evidence();
    expect(row.canonical).toBe(true);
    expect(row.issues).toEqual([]);
    expect(presentedAsMainnetGenesis(row)).toBe(true);
    expect(row.links.transaction).toBe(`https://monadscan.com/tx/${HASH}`);
    expect(row.links.block).toBe("https://monadscan.com/block/11");
    expect(row.links.contract).toBe(`https://monadscan.com/address/${addresses.chogGenesis.toLowerCase()}`);
    expect(row.links.token).toBe(`https://monadscan.com/nft/${addresses.chogGenesis.toLowerCase()}/104`);
    expect(row.links.from).toBe(`https://monadscan.com/address/${FROM}`);
    expect(row.links.to).toBe(`https://monadscan.com/address/${TO}`);
    expect(JSON.stringify(row.links)).not.toContain("testnet.monadscan.com");
    expect(evidence({}, { contract: addresses.chogGenesis.toLowerCase() }).canonical).toBe(true);
    expect(evidence({ chain_id: "143" }).canonical).toBe(true);
  });

  it("rejects the wrong chain, including testnet, without building an explorer link", () => {
    for (const chainId of [10143, 1, null, "0143"]) {
      const row = evidence({ chain_id: chainId });
      expect(row.canonical).toBe(false);
      expect(row.issues).toContain(TRANSFER_ISSUE.wrongChain);
      expect(row.links).toEqual({
        transaction: null,
        block: null,
        contract: null,
        from: null,
        to: null,
        token: null,
      });
      expect(JSON.stringify(row)).not.toContain("testnet.monadscan.com");
    }
  });

  it("rejects a payload contract that is not Chog Genesis", () => {
    const row = evidence({}, { contract: WRONG });
    expect(row.canonical).toBe(false);
    expect(row.chainStatus).toBe("confirmed");
    expect(row.issues).toContain(TRANSFER_ISSUE.wrongContract);
    expect(row.links.contract).toBeNull();
    expect(row.links.transaction).toBeNull();
    expect(row.links.token).toBeNull();
    const missing = evidence({}, { contract: "0x1234" });
    expect(missing.issues).toContain(TRANSFER_ISSUE.contractMissing);
    expect(missing.links.contract).toBeNull();
  });

  it("rejects an inconsistent payload hash even when the other fields are complete", () => {
    const row = evidence({}, { txHash: OTHER_HASH });
    expect(row.consistent).toBe(false);
    expect(row.canonical).toBe(false);
    expect(row.issues).toContain(TRANSFER_ISSUE.hashMismatch);
    expect(row.links.transaction).toBeNull();
    expect(evidence({}, { txHash: HASH.toUpperCase().replace("0X", "0x") }).consistent).toBe(true);
    expect(evidence({}, { txHash: undefined }).consistent).toBe(true);
  });

  it("rejects malformed evidence and does not build explorer links", () => {
    expect(explorerTxUrl(143, "javascript:alert(1)")).toBeNull();
    expect(explorerTxUrl(143, "0x1234")).toBeNull();
    expect(explorerTxUrl(1, HASH)).toBeNull();
    const cases: Array<[Record<string, unknown>, string, { tx_hash?: string | null }?]> = [
      [{ blockHash: "0xnot-a-hash" }, TRANSFER_ISSUE.blockHash],
      [{ blockHash: `0x${"zz".repeat(32)}` }, TRANSFER_ISSUE.blockHash],
      [{ logIndex: -1 }, TRANSFER_ISSUE.logIndex],
      [{ logIndex: "1.5" }, TRANSFER_ISSUE.logIndex],
      [{ logIndex: "abc" }, TRANSFER_ISSUE.logIndex],
      [{ logIndex: "" }, TRANSFER_ISSUE.logIndex],
      [{ logIndex: "1".repeat(11) }, TRANSFER_ISSUE.logIndex],
      [{ from: "0x1234" }, TRANSFER_ISSUE.from],
      [{ to: "not-an-address" }, TRANSFER_ISSUE.to],
      [{ tokenId: "7/2" }, TRANSFER_ISSUE.token],
      [{ tokenId: "1".repeat(79) }, TRANSFER_ISSUE.token],
      [{ tokenId: "00" }, TRANSFER_ISSUE.token],
      [{ blockNumber: "-1" }, TRANSFER_ISSUE.blockNumber],
      [{ blockNumber: "1".repeat(21) }, TRANSFER_ISSUE.blockNumber],
      [{ blockNumber: "011" }, TRANSFER_ISSUE.blockNumber],
      [{}, TRANSFER_ISSUE.txHash, { tx_hash: "0xnot-a-hash" }],
      [{}, TRANSFER_ISSUE.txHash, { tx_hash: "javascript:alert(1)" }],
      [{}, TRANSFER_ISSUE.txHash, { tx_hash: `${HASH}/../../address` }],
    ];
    for (const [payload, issue, rowPatch] of cases) {
      const row = evidence(rowPatch, payload);
      expect(row.canonical, issue).toBe(false);
      expect(row.issues, issue).toContain(issue);
      expect(row.links.transaction, issue).toBeNull();
      expect(row.links.block, issue).toBeNull();
      expect(row.links.token, issue).toBeNull();
      expect(JSON.stringify(row.links), issue).not.toContain("javascript:");
    }
  });

  it("does not treat confirmed status or a missing canonical bit as a mainnet transfer", () => {
    const partial = evidence({}, {
      tokenId: "7",
      from: FROM,
      to: TO,
      blockNumber: undefined,
      blockHash: undefined,
      logIndex: undefined,
      contract: undefined,
    });
    expect(partial.chainStatus).toBe("confirmed");
    expect(partial.canonical).toBe(false);
    expect(partial.links.transaction).toBeNull();

    const reorg = evidence({ canonical: false });
    expect(reorg.canonicalState).toBe("reorg");
    expect(reorg.issues).toContain(TRANSFER_ISSUE.reorg);
    expect(reorg.canonical).toBe(false);
    expect(reorg.links.transaction).toBeNull();

    const unset = evidence({ canonical: null });
    expect(unset.canonicalState).toBe("unset");
    expect(unset.issues).toContain(TRANSFER_ISSUE.canonicalMissing);
    expect(unset.links.transaction).toBeNull();

    const submitted = evidence({ chain_status: "submitted" });
    expect(submitted.issues).toContain(TRANSFER_ISSUE.notConfirmed);
    expect(submitted.canonical).toBe(false);
    expect(submitted.links.transaction).toBeNull();
  });

  it("does not trust a canonical flag when the stored contract is wrong", () => {
    const row = evidence();
    row.contract = WRONG;
    row.canonical = true;
    row.issues = [];
    expect(presentedAsMainnetGenesis(row)).toBe(false);
  });
});
