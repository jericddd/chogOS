// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {CitizenAccountV2} from "../src/CitizenAccountV2.sol";
import {CitizenAccountFactoryV2} from "../src/CitizenAccountFactoryV2.sol";
import {CitizenWalletProxy} from "../src/CitizenWalletProxy.sol";

/// @notice Predictions for the permanent citizen wallet.
/// This script cannot send a transaction. A later explicit authorization
/// would have to add a broadcast path in a separate change.
/// Foundry's CREATE2 deployer is Arachnid `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
/// It already has code on Monad 143. chogOS did not deploy it.
contract DeployCitizenAccountFactoryV2 is Script {
    bytes32 public constant IMPLEMENTATION_SALT = keccak256("chogOS.CitizenAccountV2.v1");
    bytes32 public constant FACTORY_SALT = keccak256("chogOS.CitizenAccountFactory.v2");
    address public constant DETERMINISTIC_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error BroadcastDisabled();

    function implementationInitCodeHash() public pure returns (bytes32) {
        return keccak256(type(CitizenAccountV2).creationCode);
    }

    function predictImplementation() public pure returns (address) {
        return vm.computeCreate2Address(IMPLEMENTATION_SALT, implementationInitCodeHash());
    }

    function factoryInitCodeHash() public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(CitizenAccountFactoryV2).creationCode, abi.encode(predictImplementation())));
    }

    function predictFactory() public pure returns (address) {
        return vm.computeCreate2Address(FACTORY_SALT, factoryInitCodeHash());
    }

    function predictAccount(uint256 chainId, address nft, uint256 tokenId) public pure returns (address) {
        address impl = predictImplementation();
        address factory = predictFactory();
        bytes32 salt = keccak256(abi.encode(chainId, nft, tokenId));
        bytes memory initData = abi.encodeCall(CitizenAccountV2.initialize, (chainId, nft, tokenId));
        bytes32 initHash = keccak256(abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(impl, initData)));
        return vm.computeCreate2Address(salt, initHash, factory);
    }

    function run() external pure {
        revert BroadcastDisabled();
    }
}
