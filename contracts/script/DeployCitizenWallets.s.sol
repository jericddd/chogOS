// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CitizenAccountFactoryV2} from "../src/CitizenAccountFactoryV2.sol";
import {CitizenAccountV2} from "../src/CitizenAccountV2.sol";
import {DeployCitizenAccountFactoryV2} from "./DeployCitizenAccountFactoryV2.s.sol";

/// @notice Deploys the pinned V2 implementation, factory, and one citizen wallet.
/// This does not deploy ChogBank and does not fund anything.
/// `run()` reverts unless chain id is 143 and CHOG_BANK_AUTHORIZE_WALLETS is the phrase below.
/// The script reads no private key. Forge still needs a gas keystore and `--broadcast` on mainnet.
contract DeployCitizenWallets is Script {
    string public constant BROADCAST_PHRASE = "yes-deploy-citizen-wallets-on-monad-mainnet";
    address public constant GENESIS = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    address public constant DETERMINISTIC_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error BroadcastDisabled();
    error WrongChain();
    error CodeMissing();
    error DeployFailed();

    function run() external returns (address wallet) {
        if (block.chainid != 143) revert WrongChain();
        if (keccak256(bytes(vm.envOr("CHOG_BANK_AUTHORIZE_WALLETS", string("")))) != keccak256(bytes(BROADCAST_PHRASE))) {
            revert BroadcastDisabled();
        }
        if (GENESIS.code.length == 0) revert CodeMissing();
        uint256 tokenId = vm.envUint("CHOG_BANK_DEMO_TOKEN_ID");
        DeployCitizenAccountFactoryV2 predicted = new DeployCitizenAccountFactoryV2();

        vm.startBroadcast();
        address implementation = _create2(predicted.IMPLEMENTATION_SALT(), type(CitizenAccountV2).creationCode);
        if (implementation != predicted.predictImplementation()) revert DeployFailed();
        bytes memory factoryCode = abi.encodePacked(type(CitizenAccountFactoryV2).creationCode, abi.encode(implementation));
        address factory = _create2(predicted.FACTORY_SALT(), factoryCode);
        if (factory != predicted.predictFactory()) revert DeployFailed();
        wallet = CitizenAccountFactoryV2(factory).create(block.chainid, GENESIS, tokenId);
        vm.stopBroadcast();

        if (wallet != predicted.predictAccount(block.chainid, GENESIS, tokenId) || wallet.code.length == 0) revert DeployFailed();
        console2.log("Citizen wallet deployed. This is not a funding address:");
        console2.logAddress(wallet);
        console2.log("Factory (not a funding address):");
        console2.logAddress(factory);
    }

    function _create2(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        deployed = vm.computeCreate2Address(salt, keccak256(initCode));
        if (deployed.code.length != 0) return deployed;
        (bool ok,) = DETERMINISTIC_CREATE2.call(abi.encodePacked(salt, initCode));
        if (!ok || deployed.code.length == 0) revert DeployFailed();
    }
}
