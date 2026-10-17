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
  /** Tokenbound Account V3 implementation. Hash-matched to Ethereum; not a chogOS deployment. */
  tokenboundAccountV3: getAddress("0x41C8f39463A868d3A88af00cd0fe7102F30E44eC"),
  /** Tokenbound Account V3 proxy. Hash-matched to Ethereum; not a chogOS deployment. */
  tokenboundAccountProxy: getAddress("0x55266d75D1a14E4572138116aF39863Ed6596E7F"),
  tokenboundAccountGuardian: getAddress("0x2fe5CCB0d7Ea195FEB87987D3573f9FccE2b5d57"),
  tokenboundForwarder: getAddress("0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD"),
  entryPointV06: getAddress("0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"),
  entryPointV07: getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),
  entryPointV08: getAddress("0x4337084d9e255fF0702461CF8895cE9E3b5Ff108"),
  entryPointV09: getAddress("0x433709009B8330FDa32311DF1C2AFA402eD8D009"),
  /** Monad's listed Safe singleton. Runtime bytecode matches Safe 1.3.0, not Safe 1.4.1. */
  safeSingleton: getAddress("0x69f4D1788e39c87893C980c06EdF4b7f686e2938"),
  /** Monad's listed SafeL2 singleton. Runtime bytecode matches SafeL2 1.3.0. */
  safeL2Singleton: getAddress("0xfb1bffC9d739B8D520DaF37dF666da4C687191EA"),
  /** Safe proxy factory 1.4.1. Runtime bytecode matches the canonical deployment. */
  safeProxyFactory: getAddress("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"),
  safeProxyFactory130: getAddress("0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"),
  safeSingleton141: getAddress("0x41675C099F32341bf84BFc5382aF534df5C7461a"),
  safeL2Singleton141: getAddress("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"),
  safeSingleton150: getAddress("0xFf51A5898e281Db6DfC7855790607438dF2ca44b"),
  safeL2Singleton150: getAddress("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"),
  safeProxyFactory150: getAddress("0x14F2982D601c9458F93bd70B218933A6f8165e7b"),
} as const satisfies Record<string, Address>;

export const CHOG_TOKEN_PROXY_BYTECODE =
  "0x363d3d373d3d3d363d737f64ccfeb3e3afd7691ea0ef404e947786cefae85af43d82803e903d91602b57fd5bf3";
