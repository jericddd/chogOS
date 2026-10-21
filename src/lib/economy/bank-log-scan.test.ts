import { encodeAbiParameters, getAddress, keccak256, toBytes, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MAX_LOG_DISTANCE,
  planLogPages,
  scanChogBankLogs,
  type BankLogKind,
  type BankLogRecord,
  type BankLogSource,
} from "@/lib/economy/bank-log-scan";

const FROM = getAddress("0x1111111111111111111111111111111111111111");
const ZERO = "0x0000000000000000000000000000000000000000";
const RECIPIENT = getAddress("0x3333333333333333333333333333333333333333");
const DECISION = `0x${"cd".repeat(32)}` as Hex;

type StoredLog = BankLogRecord & { kind: BankLogKind };

function word(value: string | bigint): Hex {
  const body = typeof value === "bigint" ? value.toString(16) : value.toLowerCase().replace(/^0x/, "");
  return `0x${body.padStart(64, "0")}`;
}

function hashFor(block: bigint, index: number): Hex {
  return word(block * 100n + BigInt(index));
}

function funded(block: bigint, amount: bigint, index = 0): StoredLog {
  return {
    kind: "funded",
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    topics: [keccak256(toBytes("Funded(address,address,uint256)")), word(FROM), word(ZERO)],
    transactionHash: hashFor(block, index),
    blockNumber: block,
    logIndex: index,
  };
}

function distributed(block: bigint, amount: bigint, index = 1): StoredLog {
  return {
    kind: "distributed",
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [ZERO, amount, 1n, `0x${"12".repeat(32)}`],
    ),
    topics: [
      keccak256(toBytes("Distributed(bytes32,uint256,address,address,uint256,uint256,bytes32)")),
      DECISION,
      toHex(104n, { size: 32 }),
      word(RECIPIENT),
    ],
    transactionHash: hashFor(block, index),
    blockNumber: block,
    logIndex: index,
  };
}

function harness(input: {
  latest: bigint;
  rows?: readonly StoredLog[];
  deploymentBlock: bigint | null;
  fail?: (query: { kind: BankLogKind; fromBlock: bigint; toBlock: bigint }) => Error | null;
  latestError?: Error;
  receipt?: (hash: Hex) => { status: "success" | "reverted"; blockNumber: bigint } | Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  limits?: Parameters<typeof scanChogBankLogs>[0]["limits"];
}) {
  const calls: Array<{ kind: BankLogKind; fromBlock: bigint; toBlock: bigint }> = [];
  let latestCalls = 0;
  const source: BankLogSource = {
    latestBlock: async () => {
      latestCalls += 1;
      if (input.latestError) throw input.latestError;
      return input.latest;
    },
    logs: async (query) => {
      calls.push(query);
      const failure = input.fail?.(query);
      if (failure) throw failure;
      return (input.rows ?? []).filter(
        (row) => row.kind === query.kind && row.blockNumber != null && row.blockNumber >= query.fromBlock && row.blockNumber <= query.toBlock,
      );
    },
    receipt: async (hash) => {
      if (input.receipt) return input.receipt(hash);
      const row = (input.rows ?? []).find((candidate) => candidate.transactionHash === hash);
      return { status: "success", blockNumber: row?.blockNumber ?? 0n };
    },
  };
  return {
    calls,
    latestCalls: () => latestCalls,
    scan: scanChogBankLogs({ deploymentBlock: input.deploymentBlock, source, limits: { concurrency: 1, ...input.limits } }),
  };
}

describe("ChogBank log pages", () => {
  it("keeps every page inside the public RPC distance", () => {
    const pages = planLogPages(0n, 250n, MAX_LOG_DISTANCE);
    expect(pages.map((page) => [page.fromBlock, page.toBlock])).toEqual([
      [0n, 100n],
      [101n, 201n],
      [202n, 250n],
    ]);
    expect(pages.every((page) => page.toBlock - page.fromBlock <= MAX_LOG_DISTANCE)).toBe(true);
    expect(planLogPages(1_000n, 1_000n)).toEqual([{ fromBlock: 1_000n, toBlock: 1_000n }]);
  });
});

describe("persistent ChogBank log scan", () => {
  it("finds Funded and Distributed events older than the old 99-block window", async () => {
    const run = harness({
      deploymentBlock: 1_000n,
      latest: 2_000n,
      rows: [funded(1_010n, 20_000_000_000_000_000n), distributed(1_020n, 10_000_000_000_000_000n)],
    });
    const scan = await run.scan;
    const oldWindow = 2_000n - 99n;
    expect(scan.status).toBe("complete");
    expect(scan.funding.map((row) => row.blockNumber)).toEqual(["1010"]);
    expect(scan.funding[0]?.amountRaw).toBe("20000000000000000");
    expect(scan.distributions.map((row) => row.tokenId)).toEqual(["104"]);
    expect(run.calls.some((call) => call.fromBlock <= 1_010n && call.toBlock >= 1_010n && call.fromBlock < oldWindow)).toBe(true);
    expect(run.calls.every((call) => call.toBlock - call.fromBlock <= MAX_LOG_DISTANCE)).toBe(true);
  });

  it("paginates from the deployment block through the latest block", async () => {
    const run = harness({
      deploymentBlock: 0n,
      latest: 250n,
      rows: [funded(10n, 2n, 0), funded(220n, 3n, 0)],
    });
    const scan = await run.scan;
    const fundedCalls = run.calls.filter((call) => call.kind === "funded");
    expect(fundedCalls.map((call) => [call.fromBlock, call.toBlock])).toEqual([
      [0n, 100n],
      [101n, 201n],
      [202n, 250n],
    ]);
    expect(scan.status).toBe("complete");
    expect(scan.coveredAll).toBe(true);
    expect(scan.funding.map((row) => row.amountRaw)).toEqual(["2", "3"]);
  });

  it("splits a page when the RPC rejects the range", async () => {
    const run = harness({
      deploymentBlock: 0n,
      latest: 80n,
      rows: [funded(60n, 9n)],
      fail: (query) => (query.toBlock - query.fromBlock > 50n ? new Error('{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}') : null),
    });
    const scan = await run.scan;
    expect(scan.status).toBe("complete");
    expect(scan.funding.map((row) => row.blockNumber)).toEqual(["60"]);
    expect(run.calls.some((call) => call.toBlock - call.fromBlock > 50n)).toBe(true);
    expect(run.calls.some((call) => call.kind === "funded" && call.fromBlock <= 60n && call.toBlock >= 60n && call.toBlock - call.fromBlock <= 50n)).toBe(true);
  });

  it("treats a missing RPC as unreadable and does not call it an empty scan", async () => {
    const run = harness({
      deploymentBlock: 10n,
      latest: 20n,
      latestError: new Error("Monad mainnet RPC is not configured."),
      rows: [funded(12n, 1n)],
    });
    const scan = await run.scan;
    expect(scan.status).toBe("unreadable");
    expect(scan.cause).toBe("rpc");
    expect(scan.reason).toContain("not configured");
    expect(scan.funding).toEqual([]);
    expect(run.calls).toHaveLength(0);
    expect(scan.status).not.toBe("empty");
  });

  it("keeps a verified older event when a later page errors", async () => {
    const run = harness({
      deploymentBlock: 0n,
      latest: 150n,
      rows: [funded(20n, 4n)],
      fail: (query) => (query.fromBlock > 100n ? new Error("database exploded") : null),
    });
    const scan = await run.scan;
    expect(scan.status).toBe("unreadable");
    expect(scan.cause).toBe("rpc");
    expect(scan.funding.map((row) => row.amountRaw)).toEqual(["4"]);
    expect(scan.reason).toContain("database exploded");
    expect(scan.status).not.toBe("empty");
  });

  it("does not turn a receipt failure into an empty scan", async () => {
    const run = harness({
      deploymentBlock: 5n,
      latest: 5n,
      rows: [distributed(5n, 7n)],
      receipt: () => Promise.reject(new Error("receipt missing")),
    });
    const scan = await run.scan;
    expect(scan.status).toBe("unreadable");
    expect(scan.cause).toBe("receipt");
    expect(scan.distributions).toEqual([]);
    expect(scan.reason).toContain("receipt could not be read");
  });

  it("reports a finished scan with only a reverted receipt as empty", async () => {
    const run = harness({
      deploymentBlock: 5n,
      latest: 8n,
      rows: [funded(6n, 1n)],
      receipt: () => ({ status: "reverted", blockNumber: 6n }),
    });
    const scan = await run.scan;
    expect(scan.status).toBe("empty");
    expect(scan.cause).toBe("empty");
    expect(scan.funding).toEqual([]);
    expect(run.calls.length).toBeGreaterThan(0);
  });

  it("does not scan when the deployment block is missing or ahead of the tip", async () => {
    const missing = harness({ deploymentBlock: null, latest: 40n, rows: [funded(12n, 1n)] });
    const ahead = harness({ deploymentBlock: 90n, latest: 40n, rows: [funded(12n, 1n)] });
    const missingScan = await missing.scan;
    const aheadScan = await ahead.scan;
    expect(missingScan.cause).toBe("no-start");
    expect(missingScan.status).toBe("unreadable");
    expect(missing.calls).toHaveLength(0);
    expect(missing.latestCalls()).toBe(0);
    expect(aheadScan.cause).toBe("ahead");
    expect(ahead.calls).toHaveLength(0);
  });

  it("stops on the budget and still returns the deployment-edge event", async () => {
    let time = 0;
    const scanning = harness({
      deploymentBlock: 0n,
      latest: 250n,
      rows: [funded(10n, 8n), funded(220n, 9n)],
      limits: { now: () => time, timeoutMs: 1_000, concurrency: 1 },
      fail: () => {
        time = 1_000;
        return null;
      },
    });
    const scan = await scanning.scan;
    expect(scan.status).toBe("unreadable");
    expect(scan.cause).toBe("timeout");
    expect(scan.funding.map((row) => row.amountRaw)).toEqual(["8"]);
    expect(scanning.calls.every((call) => call.fromBlock <= 100n)).toBe(true);
  });

  it("marks a range past the page budget as unfinished without dropping the edge events", async () => {
    const run = harness({
      deploymentBlock: 0n,
      latest: 400n,
      rows: [funded(10n, 1n, 0), funded(150n, 2n, 0), distributed(350n, 3n, 1)],
      limits: { maxPages: 2 },
    });
    const scan = await run.scan;
    expect(scan.status).toBe("unreadable");
    expect(scan.cause).toBe("gap");
    expect(scan.coveredAll).toBe(false);
    expect(scan.funding.map((row) => row.amountRaw)).toEqual(["1"]);
    expect(scan.distributions.map((row) => row.blockNumber)).toEqual(["350"]);
    expect(scan.funding.some((row) => row.amountRaw === "2")).toBe(false);
  });
});
