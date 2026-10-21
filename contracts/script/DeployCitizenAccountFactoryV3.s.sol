// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {CitizenAccountV3} from "../src/CitizenAccountV3.sol";
import {CitizenAccountFactoryV3} from "../src/CitizenAccountFactoryV3.sol";
import {CitizenWalletProxy} from "../src/CitizenWalletProxy.sol";

/// @notice Predictions for the AI-issued citizen wallet.
/// The implementation bytecode includes the agent address, so every prediction
/// takes that public address. This script cannot broadcast.
/// The V2 salts and addresses are void. Do not deploy CitizenAccountV2.
contract DeployCitizenAccountFactoryV3 is Script {
    bytes32 public constant IMPLEMENTATION_SALT = keccak256("chogOS.CitizenAccountV3.v1");
    bytes32 public constant FACTORY_SALT = keccak256("chogOS.CitizenAccountFactory.v3");
    address public constant DETERMINISTIC_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error BroadcastDisabled();

    function implementationInitCode(address agent) public pure returns (bytes memory) {
        return abi.encodePacked(type(CitizenAccountV3).creationCode, abi.encode(agent));
    }

    function predictImplementation(address agent) public pure returns (address) {
        return vm.computeCreate2Address(IMPLEMENTATION_SALT, keccak256(implementationInitCode(agent)));
    }

    function factoryInitCode(address agent) public pure returns (bytes memory) {
        return abi.encodePacked(type(CitizenAccountFactoryV3).creationCode, abi.encode(predictImplementation(agent)));
    }

    function predictFactory(address agent) public pure returns (address) {
        return vm.computeCreate2Address(FACTORY_SALT, keccak256(factoryInitCode(agent)));
    }

    function predictAccount(uint256 chainId, address nft, uint256 tokenId, address agent) public pure returns (address) {
        address impl = predictImplementation(agent);
        address factory = predictFactory(agent);
        bytes32 salt = keccak256(abi.encode(chainId, nft, tokenId));
        bytes memory initData = abi.encodeCall(CitizenAccountV3.initialize, (chainId, nft, tokenId));
        bytes32 initHash = keccak256(abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(impl, initData)));
        return vm.computeCreate2Address(salt, initHash, factory);
    }

    function run() external pure {
        revert BroadcastDisabled();
    }
}
