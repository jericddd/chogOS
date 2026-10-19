import { readFileSync } from "node:fs";
import { getAddress, pad, toHex, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { assessTransferReceipt, readTransferLog } from "@/lib/verify/transfer-log";
import { ERC721_TRANSFER_TOPIC } from "@/lib/watcher/source";
import { transferEvidenceFromRow, type TransferEvidence } from "@/lib/world/transfer";

const { clientMock } = vi.hoisted(() => ({ clientMock: vi.fn() }));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: clientMock };
});

const HASH = `0x${"ab".repeat(32)}` as Hex;
const BLOCK = `0x${"cd".repeat(32)}` as Hex;
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

function evidence(patch: { canonical?: boolean | null; chain_id?: number } = {}): TransferEvidence {
  const row = transferEvidenceFromRow({
    kind: "nft.transferred",
    chain_status: "confirmed",
    chain_id: patch.chain_id ?? 143,
    tx_hash: HASH,
    canonical: patch.canonical ?? true,
    payload: {
      tokenId: "104",
      from: FROM,
      to: TO,
      blockNumber: "11",
      blockHash: BLOCK,
      logIndex: 4,
      contract: addresses.chogGenesis,
    },
  });
  if (!row) {
    throw new Error("expected a transfer");
  }
  return row;
}

function topicAddress(address: string): Hex {
  return pad(getAddress(address), { size: 32 });
}

function receipt(patch: { tokenId?: bigint; logIndex?: number; removed?: boolean; status?: "success" | "reverted"; blockHash?: Hex } = {}) {
  return {
    status: patch.status ?? "success",
    blockNumber: 11n,
    blockHash: patch.blockHash ?? BLOCK,
    logs: [
      {
        address: getAddress(addresses.chogGenesis),
        blockHash: patch.blockHash ?? BLOCK,
        blockNumber: 11n,
        data: "0x" as Hex,
        logIndex: patch.logIndex ?? 4,
        transactionIndex: 1,
        transactionHash: HASH,
        removed: patch.removed ?? false,
        topics: [
          ERC721_TRANSFER_TOPIC,
          topicAddress(FROM),
          topicAddress(TO),
          pad(toHex(patch.tokenId ?? 104n), { size: 32 }),
        ] as [Hex, ...Hex[]],
      },
    ],
  };
}

describe("transfer receipt comparison", () => {
  const row = evidence();

  it("matches only the stored Chog Genesis log", () => {
    const ok = assessTransferReceipt(row, 143, receipt(), null);
    expect(ok).toEqual({
      attempted: true,
      matched: true,
      summary: "A read-only receipt check matched the stored Chog Genesis transfer log.",
    });
  });

  it("fails closed on the wrong chain, a bad receipt, and a mismatched log", () => {
    expect(assessTransferReceipt(row, 10143, receipt(), null).matched).toBe(false);
    expect(assessTransferReceipt(row, 143, receipt(), "The read-only RPC request failed.").matched).toBe(false);
    expect(assessTransferReceipt(row, 143, null, null).summary).toMatch(/not found/);
    expect(assessTransferReceipt(row, 143, receipt({ status: "reverted" }), null).summary).toMatch(/reverted/);
    expect(assessTransferReceipt(row, 143, receipt({ tokenId: 7n }), null).matched).toBe(false);
    expect(assessTransferReceipt(row, 143, receipt({ logIndex: 5 }), null).matched).toBe(false);
    expect(assessTransferReceipt(row, 143, receipt({ removed: true }), null).matched).toBe(false);
    expect(assessTransferReceipt(row, 143, receipt({ blockHash: `0x${"11".repeat(32)}` as Hex }), null).summary).toMatch(/block/);
    const withheld = evidence({ canonical: false });
    expect(assessTransferReceipt(withheld, 143, receipt(), null)).toMatchObject({ attempted: false, matched: false });
  });
});

describe("read-only transfer log", () => {
  const methods = {
    getChainId: vi.fn(async () => 143),
    getTransactionReceipt: vi.fn(),
  };

  beforeEach(() => {
    methods.getChainId.mockReset().mockResolvedValue(143);
    methods.getTransactionReceipt.mockReset();
    clientMock.mockReset().mockReturnValue(methods);
  });

  it("reads a matching receipt and does not claim a match for an RPC failure", async () => {
    methods.getTransactionReceipt.mockResolvedValue(receipt());
    const ok = await readTransferLog({ rpcUrl: "https://rpc.example.test/secret", evidence: evidence() });
    expect(ok.matched).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("rpc.example.test");

    methods.getChainId.mockResolvedValue(10143);
    const wrongChain = await readTransferLog({ rpcUrl: "https://rpc.example.test/secret", evidence: evidence() });
    expect(wrongChain.matched).toBe(false);
    expect(wrongChain.attempted).toBe(true);

    methods.getChainId.mockRejectedValue(new Error("HTTP request failed. URL: https://rpc.example.test/secret"));
    const failed = await readTransferLog({ rpcUrl: "https://rpc.example.test/secret", evidence: evidence() });
    expect(failed.matched).toBe(false);
    expect(failed.summary).toMatch(/redacted-url/);
    expect(failed.summary).not.toContain("secret");

    const skipped = await readTransferLog({ rpcUrl: "https://rpc.example.test/secret", evidence: evidence({ canonical: false }) });
    expect(skipped).toMatchObject({ attempted: false, matched: false });
    expect(methods.getChainId).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the RPC does not respond", async () => {
    vi.useFakeTimers();
    try {
      methods.getChainId.mockImplementation(() => new Promise(() => {}));
      const pending = readTransferLog({ rpcUrl: "https://rpc.example.test/secret", evidence: evidence() });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.matched).toBe(false);
      expect(result.attempted).toBe(true);
      expect(result.summary).toMatch(/did not respond/);
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not contain a broadcast or deploy call", () => {
    const source = readFileSync(new URL("./transfer-log.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/sendTransaction|writeContract|deployContract|signTransaction|walletClient/);
  });
});
