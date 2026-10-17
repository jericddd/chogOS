// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CitizenAccountFactory} from "../src/CitizenAccountFactory.sol";

/// @dev Mainnet factory deploy. Refuses every chain except Monad 143.
/// Foundry broadcasts `new {salt}` through Arachnid's CREATE2 proxy
/// `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which has code on Monad 143.
/// Factory address is therefore independent of the signer:
/// CREATE2(0x4e59..., FACTORY_SALT, keccak256(creationCode)).
/// Accounts are CREATE2 from the factory; this script does not create them.
/// Do not pass --broadcast until the project owner authorizes the signer.
/// Does not create citizen accounts, deploy a mock NFT, or touch a treasury.
/// Never logs a wallet key. Do not read one from the environment in this script.
contract DeployCitizenAccountFactory is Script {
    uint256 public constant MONAD_MAINNET = 143;
    bytes32 public constant FACTORY_SALT = keccak256("chogOS.CitizenAccountFactory.v1");
    address public constant DETERMINISTIC_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error NotMonadMainnet(uint256 chainId);
    error MissingCreate2Deployer();

    function factoryInitCodeHash() public pure returns (bytes32) {
        return keccak256(type(CitizenAccountFactory).creationCode);
    }

    /// @dev Address Foundry will use when broadcasting `new {salt}`.
    function predictFactory() public pure returns (address) {
        return vm.computeCreate2Address(FACTORY_SALT, factoryInitCodeHash());
    }

    function predictFactory(address deployer) public pure returns (address) {
        return vm.computeCreate2Address(FACTORY_SALT, factoryInitCodeHash(), deployer);
    }

    function run() external returns (CitizenAccountFactory factory) {
        if (block.chainid != MONAD_MAINNET) revert NotMonadMainnet(block.chainid);
        if (DETERMINISTIC_CREATE2.code.length == 0) revert MissingCreate2Deployer();

        address predicted = predictFactory();
        console2.log("chainId", block.chainid);
        console2.log("msgSender", msg.sender);
        console2.log("create2Deployer", DETERMINISTIC_CREATE2);
        console2.log("predictedFactory", predicted);

        vm.startBroadcast();
        factory = new CitizenAccountFactory{salt: FACTORY_SALT}();
        vm.stopBroadcast();

        console2.log("factory", address(factory));
        console2.log("factoryCodeSize", address(factory).code.length);
    }
}
