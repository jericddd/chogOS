> **Not the live record.** This file describes the Phase 0 shell on `main`. The live app and the deployment record are in the repository README and on `cursor/phase-1-genesis-world-155c`.

# Contract evidence

Checked on 10 October 2026. Repeat the calls with `npm run verify:contracts`. That script uses the public RPCs below, prints pass or fail, and does not request holder balances or print `ownerOf` results.

| Network | Chain id | RPC | Explorer |
| --- | --- | --- | --- |
| Monad mainnet | 143 (`0x8f`) | `https://rpc.monad.xyz` | `https://monadscan.com` |
| Monad testnet | 10143 (`0x279f`) | `https://testnet-rpc.monad.xyz` | `https://testnet.monadscan.com` |

Chain ids and RPC URLs are the ones published in Monad's network documentation:

- https://docs.monad.xyz/developer-essentials/network-information
- https://docs.monad.xyz/developer-essentials/testnet

viem 2.57.4 exports `monad` and `monadTestnet` with those same ids and default HTTP RPCs. This repo keeps the explorer URLs from the Monad docs. viem's testnet explorer URL is different, so it is not used.

## Chog Genesis

Address: `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`

| Check | Result |
| --- | --- |
| Mainnet bytecode | Present |
| Testnet bytecode | Empty |
| `name()` | `Chog Genesis` |
| `symbol()` | `CHOG` |
| `totalSupply()` | 1969 |
| `maxSupply()` | 1969 |
| `revealed()` | true |
| `supportsInterface(0x01ffc9a7)` ERC-165 | true |
| `supportsInterface(0x80ac58cd)` ERC-721 | true |
| `supportsInterface(0x5b5e139f)` ERC-721 Metadata | true |
| `supportsInterface(0x780e9d63)` ERC-721 Enumerable | false |
| `supportsInterface(0xd9b67a26)` ERC-1155 | false |
| `ownerOf(1)` | returned an address; not recorded here |
| `ownerOf(0)` | reverted |
| `treasury()` | `0x84113421A8a564b594ee9Ae78c875310332d7023` |

`supportsInterface` arguments are ABI-encoded as a right-padded `bytes4`. A left-padded encoding reverts and is not evidence.

Monadscan, on the address page fetched the same day, reported "Source Code Verified Exact Match", compiler `v0.8.28+commit.7893614a`, optimization enabled with 800 runs, and Cancun. The constructor argument type is `ChogMint.InitParams`. The ABI from that page is stored at `src/lib/blockchain/abi/chog-genesis.json`. Its SHA-256 is `3fca01bdd4b72f8034e8774cd40f582f95171a970f6a417685c589af79aa3f6d`.

The read helpers use the `name`, `symbol`, `totalSupply`, `maxSupply`, `ownerOf`, `balanceOf`, `tokenURI`, `supportsInterface`, `treasury`, and `revealed` entries from that file. They are not a separately invented interface.

`treasury()` is the collection mint receiver. It is not the civilization treasury. No balance was read for it.

The collection is not enumerable through ERC-721 Enumerable. Enrollment cannot assume `tokenByIndex`.

## $CHOG

Address: `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`

The address is the one published on https://chog.xyz/ as the $CHOG contract address.

| Check | Result |
| --- | --- |
| Mainnet bytecode | EIP-1167 minimal proxy, exact runtime bytecode recorded in `CHOG_TOKEN_PROXY_BYTECODE` |
| Implementation | `0x7f64ccFeb3E3Afd7691ea0ef404E947786cefae8`, bytecode present |
| Testnet bytecode | Empty |
| `name()` | `Chog` |
| `symbol()` | `CHOG` |
| `decimals()` | 18 |
| `totalSupply()` | `1000000000000000000000000000` (1,000,000,000 whole tokens) |
| Source verification | Not verified on the Monadscan page fetched the same day |

The implementation address is the 20 bytes embedded in the proxy bytecode. EIP-1967 implementation storage was empty, which matches a minimal proxy rather than an upgradeable proxy. There is no upgrade event to follow.

`src/lib/blockchain/abi/chog-token-observed.ts` contains only the view functions that returned data: `name`, `symbol`, `decimals`, `totalSupply`, and `balanceOf`. It is not a claim that the full ERC-20 surface was verified from source. The verification script does not call `balanceOf`.

Monadscan labeled the contract as an ERC-20 token and decoded recent `Approve` and `Transfer` calls. That labeling agrees with the view calls above. It is not a substitute for verified source.

## Infrastructure observed for the wallet plan

Bytecode presence was checked on mainnet. None of these contracts were hash-matched to upstream release artifacts.

| Name | Address | How it was identified |
| --- | --- | --- |
| Wrapped MON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | Monad mainnet canonical contracts, code present |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | Monad mainnet canonical contracts, code present |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Monad mainnet canonical contracts, code present |
| EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | Monad mainnet canonical contracts, code present |
| EntryPoint v0.9 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` | Monad mainnet canonical contracts, code present |
| Safe singleton | `0x69f4D1788e39c87893C980c06EdF4b7f686e2938` | Monad mainnet canonical contracts, code present |
| SafeL2 singleton | `0xfb1bffC9d739B8D520DaF37dF666da4C687191EA` | Monad mainnet canonical contracts, code present |
| Safe proxy factory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | Listed on the Monad testnet page. Code also present on mainnet. Not in the mainnet canonical table that was read |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | Well-known registry address. Code present. Not in the Monad canonical list that was read, and not hash-matched |

Addresses are checksummed with viem. EntryPoint v0.8's checksum differs in letter case from the Monad docs page; it is the same 20 bytes.

## What this does not establish

- No DeFi protocol, router, or pool was verified.
- No price was read.
- No wallet of this project exists.
- Testnet cannot stand in for these two Chog contracts. Both addresses have empty code there.
