// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ChogBank} from "../src/ChogBank.sol";
import {DeployCitizenAccountFactoryV2} from "./DeployCitizenAccountFactoryV2.s.sol";

/// @notice Mainnet deployment gate for the ownerless ChogBank.
/// `run()` reverts unless chain id is 143 and CHOG_BANK_AUTHORIZE_BROADCAST is the exact phrase below.
/// This file does not contain a key. Forge still needs `--broadcast` and a keystore before any transaction exists.
/// Do not fund the logged address until a separate read shows code at that address on Monad mainnet.
contract DeployChogBank is Script {
    string public constant BROADCAST_PHRASE = "yes-deploy-chogbank-on-monad-mainnet";
    address public constant GENESIS = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    address public constant CHOG = 0x350035555E10d9AfAF1566AaebfCeD5BA6C27777;

    error BroadcastDisabled();
    error WrongChain();
    error CodeMissing();
    error WalletPathMissing();
    error InvariantFailed();

    function run() external returns (ChogBank bank) {
        if (block.chainid != 143) revert WrongChain();
        if (keccak256(bytes(vm.envOr("CHOG_BANK_AUTHORIZE_BROADCAST", string("")))) != keccak256(bytes(BROADCAST_PHRASE))) {
            revert BroadcastDisabled();
        }

        address authorizer = vm.envAddress("CHOG_BANK_AUTHORIZER");
        uint256 windowSeconds = vm.envUint("CHOG_BANK_WINDOW_SECONDS");
        uint256 maxTtl = vm.envUint("CHOG_BANK_MAX_AUTHORIZATION_TTL");
        uint256 perTxMon = vm.envUint("CHOG_BANK_MAX_PER_TX_MON");
        uint256 citizenMon = vm.envUint("CHOG_BANK_MAX_CITIZEN_WINDOW_MON");
        uint256 aggregateMon = vm.envUint("CHOG_BANK_MAX_AGGREGATE_WINDOW_MON");
        uint256 perTxChog = vm.envUint("CHOG_BANK_MAX_PER_TX_CHOG");
        uint256 citizenChog = vm.envUint("CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG");
        uint256 aggregateChog = vm.envUint("CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG");

        DeployCitizenAccountFactoryV2 wallets = new DeployCitizenAccountFactoryV2();
        address factory = wallets.predictFactory();
        address implementation = wallets.predictImplementation();
        if (GENESIS.code.length == 0 || CHOG.code.length == 0) revert CodeMissing();
        if (!_walletPathReady(factory, implementation)) revert WalletPathMissing();
        uint256 demoTokenId = vm.envUint("CHOG_BANK_DEMO_TOKEN_ID");
        if (wallets.predictAccount(block.chainid, GENESIS, demoTokenId).code.length == 0) revert WalletPathMissing();

        vm.startBroadcast();
        bank = new ChogBank(
            ChogBank.Init({
                genesis: GENESIS,
                chogToken: CHOG,
                walletFactory: factory,
                walletImplementation: implementation,
                authorizer: authorizer,
                windowSeconds: windowSeconds,
                maxAuthorizationTtl: maxTtl,
                maxPerTxMon: perTxMon,
                maxCitizenWindowMon: citizenMon,
                maxAggregateWindowMon: aggregateMon,
                maxPerTxChog: perTxChog,
                maxCitizenWindowChog: citizenChog,
                maxAggregateWindowChog: aggregateChog
            })
        );
        vm.stopBroadcast();

        assertOwnerless(bank, authorizer, windowSeconds, maxTtl, perTxMon, citizenMon, aggregateMon, perTxChog, citizenChog, aggregateChog);
        console2.log("ChogBank deployed. Confirm code on Monadscan. Do not fund from this log:");
        console2.logAddress(address(bank));
        console2.log("Pinned citizen-wallet factory (not a funding address):");
        console2.logAddress(factory);
    }

    function _walletPathReady(address factory, address implementation) internal view returns (bool) {
        if (factory.code.length == 0 || implementation.code.length == 0) return false;
        (bool versionOk, bytes memory versionData) = implementation.staticcall(abi.encodeWithSignature("codeVersion()"));
        if (!versionOk || versionData.length < 32 || abi.decode(versionData, (uint256)) != 1) return false;
        (bool implOk, bytes memory implData) = factory.staticcall(abi.encodeWithSignature("implementation()"));
        return implOk && implData.length >= 32 && abi.decode(implData, (address)) == implementation;
    }

    function assertOwnerless(
        ChogBank bank,
        address authorizer,
        uint256 windowSeconds,
        uint256 maxTtl,
        uint256 perTxMon,
        uint256 citizenMon,
        uint256 aggregateMon,
        uint256 perTxChog,
        uint256 citizenChog,
        uint256 aggregateChog
    ) public view {
        if (bank.configuredChainId() != 143) revert InvariantFailed();
        if (bank.genesis() != GENESIS || bank.chogToken() != CHOG) revert InvariantFailed();
        if (bank.authorizer() != authorizer || authorizer == address(0)) revert InvariantFailed();
        if (bank.windowSeconds() != windowSeconds || bank.maxAuthorizationTtl() != maxTtl) revert InvariantFailed();
        if (bank.maxPerTxMon() != perTxMon || bank.maxCitizenWindowMon() != citizenMon || bank.maxAggregateWindowMon() != aggregateMon) {
            revert InvariantFailed();
        }
        if (bank.maxPerTxChog() != perTxChog || bank.maxCitizenWindowChog() != citizenChog || bank.maxAggregateWindowChog() != aggregateChog) {
            revert InvariantFailed();
        }
        if (perTxMon == 0 || perTxChog == 0 || perTxMon > citizenMon || citizenMon > aggregateMon) revert InvariantFailed();
        bytes32 implSlot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        bytes32 adminSlot = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
        if (vm.load(address(bank), implSlot) != bytes32(0) || vm.load(address(bank), adminSlot) != bytes32(0)) revert InvariantFailed();
    }
}
