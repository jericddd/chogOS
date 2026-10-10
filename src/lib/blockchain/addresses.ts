import { getAddress, type Address } from "viem";

/**
 * Public contract addresses. Checksums come from viem's getAddress.
 * Evidence for each address is in docs/contracts.md. Nothing here is a signer.
 */
const chogTreasury = getAddress("0x84113421A8a564b594ee9Ae78c875310332d7023");

export const addresses = {
  chogGenesis: getAddress("0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763"),
  chogToken: getAddress("0x350035555E10d9AfAF1566AaebfCeD5BA6C27777"),
  chogTokenImplementation: getAddress("0x7f64ccfeb3e3afd7691ea0ef404e947786cefae8"),
  /** NFT mint receiver and the wallet that holds the founding Chog Genesis NFTs. */
  chogGenesisMintTreasury: chogTreasury,
  /** Same address as chogGenesisMintTreasury. This is an NFT holder, not the economic treasury. */
  chogTreasury,
  wrappedMon: getAddress("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"),
  erc6551Registry: getAddress("0x000000006551c19487814612e58FE06813775758"),
  entryPointV06: getAddress("0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"),
  entryPointV07: getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),
  entryPointV08: getAddress("0x4337084d9e255fF0702461CF8895cE9E3b5Ff108"),
  entryPointV09: getAddress("0x433709009B8330FDa32311DF1C2AFA402eD8D009"),
  safeSingleton: getAddress("0x69f4D1788e39c87893C980c06EdF4b7f686e2938"),
  safeL2Singleton: getAddress("0xfb1bffC9d739B8D520DaF37dF666da4C687191EA"),
  safeProxyFactory: getAddress("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"),
} as const satisfies Record<string, Address>;

export const CHOG_TOKEN_PROXY_BYTECODE =
  "0x363d3d373d3d3d363d737f64ccfeb3e3afd7691ea0ef404e947786cefae85af43d82803e903d91602b57fd5bf3";
