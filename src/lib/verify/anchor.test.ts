import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANCHOR_ABI,
  assessAnchorObservation,
  emptyObservation,
  planAnchorRead,
  publicRpcError,
  readAnchorObservation,
  treeFormatHash,
  type AnchorEventJson,
  type AnchorObservationJson,
} from "@/lib/verify/anchor";

const { clientMock } = vi.hoisted(() => ({ clientMock: vi.fn() }));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: clientMock };
});

const ROOT = `0x${"ab".repeat(32)}` as Hex;
const BATCH = `0x${"11".repeat(32)}` as Hex;
const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const TX = `0x${"22".repeat(32)}` as Hex;
const FORMAT = treeFormatHash();

function event(patch: Partial<AnchorEventJson> = {}): AnchorEventJson {
  return {
    batchId: BATCH,
    merkleRoot: ROOT,
    fromSeq: "4",
    toSeq: "9",
    eventCount: 3,
    treeFormat: FORMAT,
    ...patch,
  };
}

function passing(patch: Partial<AnchorObservationJson> = {}): AnchorObservationJson {
  const log = event();
  return emptyObservation({
    observedChainId: 143,
    codeBytes: 128,
    receiptStatus: "success",
    receiptBlock: "15",
    event: log,
    storedBatch: { ...log, anchoredAt: "1700000000" },
    ...patch,
  });
}

const expected = {
  chainId: 143,
  root: ROOT,
  fromSeq: 4n,
  toSeq: 9n,
  eventCount: 3,
  blockNumber: 15n,
};

describe("anchor assessment", () => {
  it("accepts only a complete live match", () => {
    const ok = assessAnchorObservation(expected, passing());
    expect(ok.ok).toBe(true);
    expect(ok.pending).toBe(false);
  });

  it("fails closed for the live-check hazards", () => {
    expect(assessAnchorObservation(expected, passing({ rpcError: "timeout" })).ok).toBe(false);
    expect(assessAnchorObservation(expected, passing({ observedChainId: 10143 })).reasons[0]).toMatch(/different chain/);
    expect(assessAnchorObservation(expected, passing({ codeBytes: 0 })).reasons[0]).toMatch(/no deployed bytecode/);
    expect(assessAnchorObservation(expected, passing({ codeBytes: null })).reasons[0]).toMatch(/not read/);
    expect(assessAnchorObservation(expected, passing({ receiptStatus: "reverted", event: null, storedBatch: null })).reasons[0]).toMatch(/reverted/);
    expect(assessAnchorObservation(expected, passing({ receiptStatus: "missing", event: null, storedBatch: null }))).toMatchObject({
      ok: false,
      pending: true,
    });
    expect(assessAnchorObservation(expected, passing({ event: null, storedBatch: null })).reasons[0]).toMatch(/no BatchAnchored/);
    expect(assessAnchorObservation(expected, passing({ event: event({ merkleRoot: `0x${"00".repeat(32)}` }) })).reasons[0]).toMatch(/root does not match/);
    expect(assessAnchorObservation(expected, passing({ event: event({ fromSeq: "5" }) })).reasons[0]).toMatch(/sequence range/);
    expect(assessAnchorObservation(expected, passing({ event: event({ eventCount: 2 }) })).reasons[0]).toMatch(/event count/);
    expect(assessAnchorObservation(expected, passing({ event: event({ treeFormat: `0x${"00".repeat(32)}` }) })).reasons[0]).toMatch(/tree format/);
    const stored = { ...event(), anchoredAt: "0" };
    expect(assessAnchorObservation(expected, passing({ storedBatch: stored })).reasons[0]).toMatch(/no stored batch/);
    expect(
      assessAnchorObservation(expected, passing({ storedBatch: { ...event(), merkleRoot: `0x${"cd".repeat(32)}`, anchoredAt: "9" } })).reasons[0],
    ).toMatch(/root stored on the contract/);
    expect(
      assessAnchorObservation(expected, passing({ storedBatch: { ...event(), toSeq: "8", anchoredAt: "9" } })).reasons[0],
    ).toMatch(/stored sequence range/);
    expect(
      assessAnchorObservation(expected, passing({ storedBatch: { ...event(), eventCount: 9, anchoredAt: "9" } })).reasons[0],
    ).toMatch(/stored event count/);
    expect(
      assessAnchorObservation(expected, passing({ storedBatch: { ...event(), treeFormat: `0x${"00".repeat(32)}`, anchoredAt: "9" } })).reasons[0],
    ).toMatch(/stored tree format/);
    expect(assessAnchorObservation(expected, passing({ batchError: "bad return" })).reasons[0]).toMatch(/getBatch failed/);
  });
});

describe("anchor read plan", () => {
  const ready = {
    rpcConfigured: true,
    anchorStatus: "confirmed",
    chainId: 143,
    contract: CONTRACT,
    txHash: TX,
    root: ROOT,
    blockNumber: 15,
  };

  it("does not read when nothing has been anchored", () => {
    expect(planAnchorRead({ ...ready, anchorStatus: "unanchored" }).action).toBe("none");
  });

  it("keeps a failed anchor without a transaction off the live read", () => {
    const plan = planAnchorRead({ ...ready, anchorStatus: "failed", txHash: null });
    expect(plan.action).toBe("none");
    expect(plan.reason).toMatch(/failed/);
  });

  it("refuses a confirmed record that cannot be read", () => {
    expect(planAnchorRead({ ...ready, rpcConfigured: false }).action).toBe("ready");
    expect(planAnchorRead({ ...ready, txHash: "0x1234" }).action).toBe("invalid");
    expect(planAnchorRead({ ...ready, chainId: 1 }).action).toBe("invalid");
    expect(planAnchorRead({ ...ready, contract: "0x1234" }).action).toBe("invalid");
  });
});

describe("read-only anchor observation", () => {
  const methods = {
    getChainId: vi.fn(async () => 143),
    getCode: vi.fn(async () => `0x${"60".repeat(16)}` as Hex),
    getTransactionReceipt: vi.fn(),
    readContract: vi.fn(),
  };

  beforeEach(() => {
    methods.getChainId.mockReset().mockResolvedValue(143);
    methods.getCode.mockReset().mockResolvedValue(`0x${"60".repeat(16)}`);
    methods.getTransactionReceipt.mockReset();
    methods.readContract.mockReset();
    clientMock.mockReset().mockReturnValue(methods);
  });

  function log(root: Hex = ROOT) {
    const topics = encodeEventTopics({
      abi: ANCHOR_ABI,
      eventName: "BatchAnchored",
      args: { batchId: BATCH },
    });
    const data = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [root, 4n, 9n, 3, FORMAT],
    );
    return {
      address: CONTRACT,
      topics,
      data,
      blockNumber: 15n,
      transactionHash: TX,
      logIndex: 0,
      transactionIndex: 0,
      removed: false,
      blockHash: `0x${"33".repeat(32)}` as Hex,
    };
  }

  it("reads a matching root from the receipt and getBatch", async () => {
    methods.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 15n, logs: [log()] });
    methods.readContract.mockResolvedValue({
      merkleRoot: ROOT,
      fromSeq: 4n,
      toSeq: 9n,
      eventCount: 3,
      treeFormat: FORMAT,
      anchoredAt: 1700000000n,
    });
    const observation = await readAnchorObservation({
      rpcUrl: "https://rpc.example.test/secret",
      chainId: 143,
      contract: CONTRACT,
      txHash: TX,
      expectedRoot: ROOT,
    });
    expect(assessAnchorObservation(expected, observation).ok).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("rpc.example.test");
    expect(clientMock).toHaveBeenCalled();
  });

  it("reports a missing receipt as pending and redacts RPC URLs", async () => {
    methods.getTransactionReceipt.mockRejectedValue(new Error("could not be found at https://rpc.example.test/secret"));
    const missing = await readAnchorObservation({
      rpcUrl: "https://rpc.example.test/secret",
      chainId: 143,
      contract: CONTRACT,
      txHash: TX,
      expectedRoot: ROOT,
    });
    expect(missing.receiptStatus).toBe("missing");
    expect(JSON.stringify(missing)).not.toContain("rpc.example.test");
    expect(assessAnchorObservation(expected, missing).pending).toBe(true);

    methods.getChainId.mockRejectedValue(new Error("HTTP request failed. URL: https://rpc.example.test/secret"));
    const failed = await readAnchorObservation({
      rpcUrl: "https://rpc.example.test/secret",
      chainId: 143,
      contract: CONTRACT,
      txHash: TX,
      expectedRoot: ROOT,
    });
    expect(failed.rpcError).toMatch(/redacted-url/);
    expect(failed.rpcError).not.toContain("secret");
    expect(assessAnchorObservation(expected, failed).ok).toBe(false);
  });

  it("does not contain a broadcast or deploy call", () => {
    const source = readFileSync(new URL("./anchor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/sendTransaction|writeContract|deployContract|signTransaction|walletClient/);
    expect(publicRpcError(new Error("down https://rpc.example.test/secret"), "fallback")).not.toContain("secret");
  });
});
