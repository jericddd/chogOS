import { concat, getAddress, keccak256, type Address, type Hex } from "viem";
import { nftBoundSalt, type NftIdentity } from "@/lib/wallets/nft-bound";

/** Arachnid CREATE2 proxy. Observed on Monad 143; chogOS did not deploy it. */
export const DETERMINISTIC_CREATE2 = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");

/** V1 factory. Empty on live 143. Must stay unused after the V1.1 bytecode change. */
export const V1_FACTORY_PREDICTED = getAddress("0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c");

export const V11_FACTORY_SALT_LABEL = "chogOS.CitizenAccountFactory.v1.1";
export const V11_FACTORY_SALT = keccak256(new TextEncoder().encode(V11_FACTORY_SALT_LABEL));

/**
 * CREATE2(0x4e59…, v1.1 salt, keccak256(CitizenAccountFactory creation)).
 * Predicted is not deployed.
 */
export const V11_FACTORY_PREDICTED = getAddress("0xA2edAC990B30A488D61fc4607D4365b22e41e39c");

export const V11_FACTORY_CREATION_KECCAK =
  "0x5ab92f75510fe5aab95ef0581ccff98f78dabef95629ac8b868fb1702f10686a" as Hex;
export const V11_FACTORY_RUNTIME_KECCAK =
  "0x62083b6aafa8ea3248d8b3aac09bcc3342250615d8d13fc9a1a6bdb6e22ab9f4" as Hex;
export const V11_ACCOUNT_CREATION_KECCAK =
  "0x1f22f0ec692ba08d6103826769a996545ff4dbf2189491cb1df48cbc4773ec53" as Hex;
export const V11_ACCOUNT_RUNTIME_KECCAK =
  "0x679fb5aa3a35d4f680012018e0ea9db9b70869d5e503be32b165b59f6b6d10ae" as Hex;

/**
 * V2 permanent wallet. Not deployed.
 * The implementation and factory are CREATE2 from Arachnid 0x4e59….
 * A citizen wallet is a proxy CREATE2 from the factory. The implementation
 * is immutable. There is no upgrade. predictedFactoryAddress() stays on
 * the unused V1.1 factory.
 * These hashes match the immutable-proxy bytecode. Predictions from the
 * earlier upgradeable draft are void.
 */
export const V2_IMPLEMENTATION_SALT_LABEL = "chogOS.CitizenAccountV2.v1";
export const V2_IMPLEMENTATION_SALT = keccak256(new TextEncoder().encode(V2_IMPLEMENTATION_SALT_LABEL));
export const V2_FACTORY_SALT_LABEL = "chogOS.CitizenAccountFactory.v2";
export const V2_FACTORY_SALT = keccak256(new TextEncoder().encode(V2_FACTORY_SALT_LABEL));
export const V2_IMPLEMENTATION_PREDICTED = getAddress("0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632");
export const V2_FACTORY_PREDICTED = getAddress("0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD");
export const V2_IMPLEMENTATION_CREATION_KECCAK =
  "0x19c106f6993aad95c63cf742ec0eec9323f889a6feefd7ee8897768d216f1251" as Hex;
export const V2_FACTORY_CREATION_KECCAK =
  "0xf949dcca45c301030267e8a46ecc2aabab92a79ad49d147a1b327307f00e1a64" as Hex;
/** Chain 143, Chog Genesis token 104. Predicted only. */
export const V2_WALLET_104_PREDICTED = getAddress("0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502");
/** Chain 143, Chog Genesis token 129. Predicted only. */
export const V2_WALLET_129_PREDICTED = getAddress("0x492905adbc786264f0195FAE4516F5275BB3b960");

export function create2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const digest = keccak256(concat(["0xff", deployer, salt, initCodeHash]));
  return getAddress(`0x${digest.slice(-40)}`);
}

export function predictedFactoryAddress(): Address {
  return create2Address(DETERMINISTIC_CREATE2, V11_FACTORY_SALT, V11_FACTORY_CREATION_KECCAK);
}

export function predictedV2ImplementationAddress(): Address {
  return create2Address(DETERMINISTIC_CREATE2, V2_IMPLEMENTATION_SALT, V2_IMPLEMENTATION_CREATION_KECCAK);
}

export function predictedV2FactoryAddress(): Address {
  return create2Address(DETERMINISTIC_CREATE2, V2_FACTORY_SALT, V2_FACTORY_CREATION_KECCAK);
}

/**
 * Account CREATE2 needs the factory address plus keccak256(creationCode ++ args).
 * That init hash is per identity. A factory prediction is not an account.
 */
export function predictAccountAddress(input: {
  factory: Address;
  identity: NftIdentity;
  accountInitCodeHash: Hex;
}): Address {
  return create2Address(input.factory, nftBoundSalt(input.identity), input.accountInitCodeHash);
}

export function identityKey(identity: Pick<NftIdentity, "chainId" | "nftContract" | "tokenId">): string {
  return `${identity.chainId}:${getAddress(identity.nftContract).toLowerCase()}:${identity.tokenId.toString()}`;
}
