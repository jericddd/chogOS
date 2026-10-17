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

Bytecode presence was checked on mainnet during Phase 0. That pass did not hash-match the contracts. A later pass on 12 October 2026 compared `eth_getCode` on Monad mainnet with known Safe, EntryPoint, and ERC-6551 bytecode. The hashes that matched are stored in `src/lib/wallets/infrastructure.ts`. A hash match means the code at that address matches a published artifact. It does not mean chogOS deployed it.

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

### Hash check on 12 October 2026

| Name | Address | Result |
| --- | --- | --- |
| Safe 1.3.0 singleton (Monad's listed address) | `0x69f4D1788e39c87893C980c06EdF4b7f686e2938` | Matches Safe 1.3.0, not Safe 1.4.1 |
| SafeL2 1.3.0 | `0xfb1bffC9d739B8D520DaF37dF666da4C687191EA` | Matches SafeL2 1.3.0 |
| Safe proxy factory 1.3.0 | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | Matches |
| Safe 1.4.1 singleton | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | Matches Safe 1.4.1 and the same address on Ethereum |
| SafeL2 1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | Matches |
| Safe proxy factory 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | Matches |
| Safe 1.5.0 singleton | `0xFf51A5898e281Db6DfC7855790607438dF2ca44b` | Matches |
| SafeL2 1.5.0 | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` | Matches |
| Safe proxy factory 1.5.0 | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | Matches |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | Matches Ethereum |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Matches Ethereum |
| EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | Code is present. The hash does not match Ethereum, so it is not treated as canonical |
| EntryPoint v0.9 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` | Code is present. The hash does not match Ethereum, so it is not treated as canonical |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | Matches Ethereum |

No ERC-6551 account implementation was hash-matched, so no citizen account address is derived from the registry. A standard Safe does not read `ownerOf`, so these factories are not used to predict citizen wallets in Phase 2.

### Hash check on 17 October 2026 (Phase 6a)

`cast keccak` of `eth_getCode` on Monad mainnet (143), Monad testnet (10143), and Ethereum. Matching hashes across those networks are recorded in `src/lib/wallets/infrastructure.ts`. This is not a chogOS deployment.

| Name | Address | Monad mainnet | Monad testnet | Ethereum |
| --- | --- | --- | --- | --- |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | `0xda1d5b06…d6735` | same | same |
| Tokenbound Account V3 | `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC` | `0xdf5eeb80…0f85b` | same | same |
| Tokenbound Account Proxy | `0x55266d75D1a14E4572138116aF39863Ed6596E7F` | `0x7f2b4bea…afdb0` | same | same |
| Tokenbound Account Guardian | `0x2fe5CCB0d7Ea195FEB87987D3573f9FccE2b5d57` | `0x852cc932…093f2` | present, same hash as mainnet | not compared |
| Tokenbound Forwarder | `0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD` | `0xb074cd81…8895c` | present, same hash as mainnet | not compared |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | `0xc93c806e…c8e70` | same | same |

Tokenbound addresses are the ones published in [Monad's ERC-6551 guide](https://docs.monad.xyz/guides/erc-6551) and [Tokenbound deployments](https://docs.tokenbound.org/contracts/deployments). Source-verified explorer pages were not re-audited line-by-line. Bytecode equality with Ethereum is the check recorded here.

Chog Genesis and $CHOG still have empty code on testnet. A Testnet proof of the citizen account therefore needs a mock ERC-721, not the mainnet NFT address.

## What this does not establish

- No DeFi protocol, router, or pool was verified.
- No price was read.
- No wallet of this project exists.
- Testnet cannot stand in for these two Chog contracts. Both addresses have empty code there.
