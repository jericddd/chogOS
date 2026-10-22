import { encodeAbiParameters, encodeEventTopics, getAddress, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { issuanceDecisionId } from "@/lib/wallets/issuance";
import { factoryAbi, lowestIssuerFees, matchAccountCreated } from "@/lib/wallets/issuer";

describe("wallet issuer", () => {
  it("keeps the paid tip at 1 wei above the base fee", () => {
    const fees = lowestIssuerFees(100_000_000_000n);
    expect(fees.maxPriorityFeePerGas).toBe(1n);
    expect(fees.maxFeePerGas).toBe(120_000_000_001n);
  });

  it("accepts only the AccountCreated log for the expected decision", () => {
    const factory = getAddress("0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A");
    const account = getAddress("0x238797c75Ad0423516F84D917B7A9d765831bf02");
    const decisionId = issuanceDecisionId("7");
    const topics = encodeEventTopics({
      abi: factoryAbi,
      eventName: "AccountCreated",
      args: { account },
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [143n, addresses.chogGenesis, 7n, decisionId],
    );
    const log = { address: factory, topics, data };
    expect(matchAccountCreated([log], { factory, tokenId: 7n, decisionId })?.account).toBe(account);
    expect(matchAccountCreated([log], { factory, tokenId: 104n, decisionId })).toBeNull();
    expect(matchAccountCreated([{ ...log, address: account }], { factory, tokenId: 7n, decisionId })).toBeNull();
  });

  it("rejects a decision id that was not derived from the token", () => {
    const foreign = toHex(new Uint8Array(32).fill(1)) as Hex;
    const topics = encodeEventTopics({
      abi: factoryAbi,
      eventName: "AccountCreated",
      args: { account: getAddress("0x238797c75Ad0423516F84D917B7A9d765831bf02") },
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [143n, addresses.chogGenesis, 7n, foreign],
    );
    const factory = getAddress("0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A");
    expect(matchAccountCreated([{ address: factory, topics, data }], { factory, tokenId: 7n, decisionId: issuanceDecisionId("7") })).toBeNull();
  });
});
