import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import {
  ERC20_TRANSFER_TOPIC,
  presentOtherTokens,
  scanHeldTokens,
  tokenAddressesFromTransferLogs,
  type HeldTokenLog,
  type HeldTokenSource,
} from "@/lib/economy/held-tokens";

const BANK = getAddress("0x2222222222222222222222222222222222222222");
const WIDGET = getAddress("0x4444444444444444444444444444444444444444");
const OTHER = getAddress("0x5555555555555555555555555555555555555555");
const STRANGER = getAddress("0x6666666666666666666666666666666666666666");

function topic(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function transfer(token: string, to: string, removed = false): HeldTokenLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic(STRANGER), topic(to)],
    removed,
  };
}

function source(input: {
  latest?: bigint;
  logs?: readonly HeldTokenLog[];
  balances?: Record<string, bigint | null>;
  failLatest?: boolean;
  failWide?: boolean;
}): HeldTokenSource {
  return {
    latestBlock: async () => {
      if (input.failLatest) throw new Error("rpc down");
      return input.latest ?? 10n;
    },
    logs: async (query) => {
      if (input.failWide && query.toBlock - query.fromBlock > 50n) throw new Error("eth_getLogs is limited to a 100 range");
      return (input.logs ?? []).filter(() => true);
    },
    token: async (address) => {
      const balance = input.balances?.[address.toLowerCase()];
      return {
        balance: balance === undefined ? 0n : balance,
        symbol: address.toLowerCase() === WIDGET.toLowerCase() ? "WIDGET" : "weird name!",
        decimals: 18,
      };
    },
  };
}

describe("held token discovery", () => {
  it("keeps tokens transferred to the bank and skips $CHOG, other recipients, and removed logs", () => {
    const found = tokenAddressesFromTransferLogs(
      [
        transfer(WIDGET, BANK),
        transfer(addresses.chogToken, BANK),
        transfer(OTHER, STRANGER),
        transfer(OTHER, BANK, true),
        transfer(WIDGET, BANK),
      ],
      BANK,
      [addresses.chogToken],
    );
    expect(found).toEqual([WIDGET]);
  });

  it("does not read logs when the deployment block is missing", async () => {
    let calls = 0;
    const scan = await scanHeldTokens({
      bank: BANK,
      deploymentBlock: null,
      source: {
        latestBlock: async () => {
          calls += 1;
          return 1n;
        },
        logs: async () => {
          calls += 1;
          return [];
        },
        token: async () => {
          calls += 1;
          return { balance: 1n, symbol: "WIDGET", decimals: 18 };
        },
      },
    });
    expect(scan).toEqual({ status: "unread", rows: [] });
    expect(calls).toBe(0);
  });

  it("lists a non-zero balance and drops a token that was transferred out", async () => {
    const scan = await scanHeldTokens({
      bank: BANK,
      deploymentBlock: 10n,
      source: source({
        latest: 10n,
        logs: [transfer(WIDGET, BANK), transfer(OTHER, BANK)],
        balances: { [WIDGET.toLowerCase()]: 1_500_000_000_000_000_000n, [OTHER.toLowerCase()]: 0n },
      }),
    });
    expect(scan.status).toBe("complete");
    expect(scan.rows).toEqual([
      { address: WIDGET, symbol: "WIDGET", decimals: 18, raw: "1500000000000000000" },
    ]);
    const view = presentOtherTokens(scan);
    expect(view.status).toBe("complete");
    expect(view.rows[0]).toMatchObject({ label: "WIDGET", amountText: "1.5" });
    expect(view.note).toContain("stay in the contract");
  });

  it("says the list is partial when a discovered balance cannot be read", async () => {
    const scan = await scanHeldTokens({
      bank: BANK,
      deploymentBlock: 10n,
      source: source({
        latest: 10n,
        logs: [transfer(WIDGET, BANK), transfer(OTHER, BANK)],
        balances: { [WIDGET.toLowerCase()]: 2n, [OTHER.toLowerCase()]: null },
      }),
    });
    expect(scan.status).toBe("partial");
    expect(scan.rows.map((row) => row.address)).toEqual([WIDGET]);
    expect(presentOtherTokens(scan).note).toContain("not proof");
  });

  it("does not call a short scan empty when the block range was not covered", async () => {
    const scan = await scanHeldTokens({
      bank: BANK,
      deploymentBlock: 0n,
      limits: { maxPages: 1 },
      source: source({ latest: 1_000n, logs: [] }),
    });
    expect(scan.status).toBe("partial");
    expect(scan.rows).toEqual([]);
    expect(presentOtherTokens(scan).note).not.toContain("No other token balance was found");
  });

  it("splits a range the RPC rejects and still reports the token", async () => {
    const scan = await scanHeldTokens({
      bank: BANK,
      deploymentBlock: 0n,
      source: source({
        latest: 80n,
        failWide: true,
        logs: [transfer(WIDGET, BANK)],
        balances: { [WIDGET.toLowerCase()]: 4n },
      }),
    });
    expect(scan.status).toBe("complete");
    expect(scan.rows[0]?.raw).toBe("4");
  });

  it("labels a reserved or unreadable symbol as an unknown token", () => {
    const view = presentOtherTokens({
      status: "complete",
      rows: [
        { address: WIDGET, symbol: "MON", decimals: 18, raw: "1000000000000000000" },
        { address: OTHER, symbol: null, decimals: null, raw: "9" },
      ],
    });
    expect(view.rows.map((row) => row.label)).toEqual(["Unknown token", "Unknown token"]);
    expect(view.rows[0]?.amountText).toBe("1");
    expect(view.rows[1]?.amountText).toBe("9 raw units");
    expect(view.rows.some((row) => row.address.toLowerCase() === addresses.chogToken.toLowerCase())).toBe(false);
  });
});
