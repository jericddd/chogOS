import { getAddress, type Address, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";

/**
 * Runtime code hashes checked on Monad mainnet on 12 October 2026.
 * A hash match is evidence of bytecode. It is not a deployment by chogOS.
 */
export const codeHashes = {
  safe130: "0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e",
  safeL2130: "0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f",
  safeFactory130: "0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b",
  safe141: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
  safeL2141: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  safeFactory141: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  safe150: "0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2",
  safeL2150: "0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc",
  safeFactory150: "0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529",
  entryPoint06: "0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70",
  entryPoint07: "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58",
  erc6551Registry: "0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735",
} as const;

export type SafeVersion =
  | "safe-1.3.0"
  | "safe-l2-1.3.0"
  | "safe-1.4.1"
  | "safe-l2-1.4.1"
  | "safe-1.5.0"
  | "safe-l2-1.5.0";

const singleTons: Array<{ version: SafeVersion; address: Address }> = [
  { version: "safe-1.3.0", address: addresses.safeSingleton },
  { version: "safe-l2-1.3.0", address: addresses.safeL2Singleton },
  { version: "safe-1.4.1", address: addresses.safeSingleton141 },
  { version: "safe-l2-1.4.1", address: addresses.safeL2Singleton141 },
  { version: "safe-1.5.0", address: addresses.safeSingleton150 },
  { version: "safe-l2-1.5.0", address: addresses.safeL2Singleton150 },
];

const infrastructureNames: Array<{ address: Address; name: string }> = [
  ...singleTons.map((item) => ({ address: item.address, name: item.version })),
  { address: addresses.safeProxyFactory130, name: "safe-proxy-factory-1.3.0" },
  { address: addresses.safeProxyFactory, name: "safe-proxy-factory-1.4.1" },
  { address: addresses.safeProxyFactory150, name: "safe-proxy-factory-1.5.0" },
  { address: addresses.entryPointV06, name: "entrypoint-0.6" },
  { address: addresses.entryPointV07, name: "entrypoint-0.7" },
  { address: addresses.entryPointV08, name: "entrypoint-0.8" },
  { address: addresses.entryPointV09, name: "entrypoint-0.9" },
  { address: addresses.erc6551Registry, name: "erc6551-registry" },
];

export function safeVersionForMasterCopy(masterCopy: Address): SafeVersion | null {
  const found = singleTons.find((item) => item.address.toLowerCase() === masterCopy.toLowerCase());
  return found?.version ?? null;
}

export function infrastructureName(address: string): string | null {
  let checksum: Address;
  try {
    checksum = getAddress(address);
  } catch {
    return null;
  }
  const found = infrastructureNames.find((item) => item.address.toLowerCase() === checksum.toLowerCase());
  return found?.name ?? null;
}

export function hashMatchesKnownSafe(hash: Hex | null): SafeVersion | null {
  if (!hash) {
    return null;
  }
  const table: Record<string, SafeVersion> = {
    [codeHashes.safe130]: "safe-1.3.0",
    [codeHashes.safeL2130]: "safe-l2-1.3.0",
    [codeHashes.safe141]: "safe-1.4.1",
    [codeHashes.safeL2141]: "safe-l2-1.4.1",
    [codeHashes.safe150]: "safe-1.5.0",
    [codeHashes.safeL2150]: "safe-l2-1.5.0",
  };
  return table[hash.toLowerCase()] ?? null;
}
