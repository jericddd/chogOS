import { describe, expect, it } from "vitest";
import { explorerAddressUrl, explorerBlockUrl, explorerNftUrl, explorerOrigin, explorerTxUrl } from "@/lib/blockchain/explorer";

const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763";

describe("explorer links", () => {
  it("builds Monadscan transaction, address, block, and NFT links", () => {
    expect(explorerOrigin(143)).toBe("https://monadscan.com");
    expect(explorerTxUrl(143, HASH)).toBe(`https://monadscan.com/tx/${HASH}`);
    expect(explorerAddressUrl(143, ADDRESS)).toBe(`https://monadscan.com/address/${ADDRESS}`);
    expect(explorerBlockUrl(143, 11)).toBe("https://monadscan.com/block/11");
    expect(explorerBlockUrl(143, "11")).toBe("https://monadscan.com/block/11");
    expect(explorerNftUrl(143, ADDRESS, "104")).toBe(`https://monadscan.com/nft/${ADDRESS}/104`);
    expect(explorerTxUrl(10143, HASH)).toBe(`https://testnet.monadscan.com/tx/${HASH}`);
  });

  it("rejects identifiers that are not explorer objects", () => {
    expect(explorerTxUrl(143, "0x1234")).toBeNull();
    expect(explorerTxUrl(143, "javascript:alert(1)")).toBeNull();
    expect(explorerTxUrl(143, `${HASH}/../../address`)).toBeNull();
    expect(explorerTxUrl(1, HASH)).toBeNull();
    expect(explorerTxUrl(null, HASH)).toBeNull();
    expect(explorerAddressUrl(143, "0x1234")).toBeNull();
    expect(explorerAddressUrl(143, "not-an-address")).toBeNull();
    expect(explorerBlockUrl(143, "11;drop")).toBeNull();
    expect(explorerBlockUrl(143, "-1")).toBeNull();
    expect(explorerBlockUrl(143, "1".repeat(21))).toBeNull();
    expect(explorerNftUrl(143, ADDRESS, "1/2")).toBeNull();
    expect(explorerNftUrl(143, "0x1234", "7")).toBeNull();
    expect(explorerNftUrl(143, ADDRESS, "")).toBeNull();
  });

  it("lowercases valid hex and does not keep a caller-supplied host", () => {
    const mixed = `0x${"AB".repeat(32)}`;
    expect(explorerTxUrl(143, mixed)).toBe(`https://monadscan.com/tx/${HASH}`);
    expect(explorerAddressUrl(143, ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(
      `https://monadscan.com/address/${ADDRESS}`,
    );
  });
});
