import { isAddress, type Address, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { chogGenesisReadAbi } from "../src/lib/blockchain/abi/chog-genesis-reads";
import { chogTokenObservedAbi } from "../src/lib/blockchain/abi/chog-token-observed";
import {
  addresses,
  CHOG_TOKEN_PROXY_BYTECODE,
} from "../src/lib/blockchain/addresses";
import { createChainClient } from "../src/lib/blockchain/public-client";

const interfaces = {
  erc165: "0x01ffc9a7",
  erc721: "0x80ac58cd",
  erc721Metadata: "0x5b5e139f",
  erc721Enumerable: "0x780e9d63",
  erc1155: "0xd9b67a26",
} as const;

function check(name: string, condition: boolean): void {
  if (!condition) {
    throw new Error(name);
  }
  console.log(`ok  ${name}`);
}

async function bytecodeSize(client: PublicClient, address: Address): Promise<number> {
  const code = await client.getBytecode({ address });
  if (!code) {
    return 0;
  }
  return (code.length - 2) / 2;
}

async function main(): Promise<void> {
  check("viem mainnet id is 143", monad.id === 143);
  check("viem testnet id is 10143", monadTestnet.id === 10143);
  check(
    "viem mainnet RPC is the documented public endpoint",
    monad.rpcUrls.default.http[0] === "https://rpc.monad.xyz",
  );
  check(
    "viem testnet RPC is the documented public endpoint",
    monadTestnet.rpcUrls.default.http[0] === "https://testnet-rpc.monad.xyz",
  );

  const mainnet = createChainClient(143);
  const testnet = createChainClient(10143);
  const mainnetId = await mainnet.getChainId();
  const testnetId = await testnet.getChainId();
  check("mainnet eth_chainId is 143", mainnetId === 143);
  check("testnet eth_chainId is 10143", testnetId === 10143);

  const nft = addresses.chogGenesis;
  const token = addresses.chogToken;

  check("Chog Genesis has bytecode on mainnet", (await bytecodeSize(mainnet, nft)) > 0);
  check("Chog Genesis has no bytecode on testnet", (await bytecodeSize(testnet, nft)) === 0);
  check("$CHOG has no bytecode on testnet", (await bytecodeSize(testnet, token)) === 0);

  const proxyCode = await mainnet.getBytecode({ address: token });
  check(
    "$CHOG mainnet bytecode is the observed EIP-1167 proxy",
    proxyCode?.toLowerCase() === CHOG_TOKEN_PROXY_BYTECODE,
  );
  check(
    "$CHOG implementation has bytecode",
    (await bytecodeSize(mainnet, addresses.chogTokenImplementation)) > 0,
  );

  const [name, symbol, totalSupply, maxSupply, revealed, mintTreasury] = await Promise.all([
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "name" }),
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "symbol" }),
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "totalSupply" }),
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "maxSupply" }),
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "revealed" }),
    mainnet.readContract({ address: nft, abi: chogGenesisReadAbi, functionName: "treasury" }),
  ]);

  check("Chog Genesis name is Chog Genesis", name === "Chog Genesis");
  check("Chog Genesis symbol is CHOG", symbol === "CHOG");
  check("Chog Genesis totalSupply is 1969", totalSupply === BigInt(1969));
  check("Chog Genesis maxSupply is 1969", maxSupply === BigInt(1969));
  check("Chog Genesis revealed() is true", revealed === true);
  check(
    "Chog Genesis treasury() matches the recorded mint receiver",
    mintTreasury === addresses.chogGenesisMintTreasury,
  );

  for (const [label, id] of Object.entries(interfaces)) {
    const supported = await mainnet.readContract({
      address: nft,
      abi: chogGenesisReadAbi,
      functionName: "supportsInterface",
      args: [id],
    });
    const expected = label === "erc165" || label === "erc721" || label === "erc721Metadata";
    check(`supportsInterface ${label} is ${expected}`, supported === expected);
  }

  const owner = await mainnet.readContract({
    address: nft,
    abi: chogGenesisReadAbi,
    functionName: "ownerOf",
    args: [BigInt(1)],
  });
  check("ownerOf(1) returns an address and is not printed", isAddress(owner) && owner !== "0x0000000000000000000000000000000000000000");

  let missingTokenReverted = false;
  try {
    await mainnet.readContract({
      address: nft,
      abi: chogGenesisReadAbi,
      functionName: "ownerOf",
      args: [BigInt(0)],
    });
  } catch {
    missingTokenReverted = true;
  }
  check("ownerOf(0) reverts", missingTokenReverted);

  const [tokenName, tokenSymbol, decimals, tokenSupply] = await Promise.all([
    mainnet.readContract({ address: token, abi: chogTokenObservedAbi, functionName: "name" }),
    mainnet.readContract({ address: token, abi: chogTokenObservedAbi, functionName: "symbol" }),
    mainnet.readContract({ address: token, abi: chogTokenObservedAbi, functionName: "decimals" }),
    mainnet.readContract({ address: token, abi: chogTokenObservedAbi, functionName: "totalSupply" }),
  ]);
  check("$CHOG name is Chog", tokenName === "Chog");
  check("$CHOG symbol is CHOG", tokenSymbol === "CHOG");
  check("$CHOG decimals is 18", decimals === 18);
  check(
    "$CHOG totalSupply is 1e9 whole tokens",
    tokenSupply === BigInt("1000000000000000000000000000"),
  );

  const documented: Array<[string, Address]> = [
    ["Wrapped MON", addresses.wrappedMon],
    ["EntryPoint v0.6", addresses.entryPointV06],
    ["EntryPoint v0.7", addresses.entryPointV07],
    ["EntryPoint v0.8", addresses.entryPointV08],
    ["EntryPoint v0.9", addresses.entryPointV09],
    ["Safe singleton", addresses.safeSingleton],
    ["SafeL2 singleton", addresses.safeL2Singleton],
  ];
  for (const [label, address] of documented) {
    check(`${label} has bytecode on mainnet`, (await bytecodeSize(mainnet, address)) > 0);
  }

  check(
    "ERC-6551 registry address has bytecode on mainnet",
    (await bytecodeSize(mainnet, addresses.erc6551Registry)) > 0,
  );
  check(
    "Safe proxy factory address has bytecode on mainnet",
    (await bytecodeSize(mainnet, addresses.safeProxyFactory)) > 0,
  );

  console.log("Contract verification passed. No holder balances were requested.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Contract verification failed.";
  console.error(`fail ${message}`);
  process.exitCode = 1;
});
