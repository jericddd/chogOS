// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CitizenAccountFactoryV3} from "../src/CitizenAccountFactoryV3.sol";
import {DeployCitizenAccountFactoryV3} from "./DeployCitizenAccountFactoryV3.s.sol";

/// @notice Deploys the V3 implementation, factory, and one citizen wallet.
/// The agent key is read from CHOG_WALLET_AGENT_KEY only inside this script.
/// Do not put that name in the application environment. This does not fund anything.
contract DeployCitizenWallets is Script {
    string public constant BROADCAST_PHRASE = "yes-deploy-citizen-wallets-on-monad-mainnet";
    address public constant GENESIS = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    address public constant DETERMINISTIC_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error BroadcastDisabled();
    error WrongChain();
    error CodeMissing();
    error DeployFailed();
    error BadSigner();

    function run() external returns (address wallet) {
        if (block.chainid != 143) revert WrongChain();
        if (keccak256(bytes(vm.envOr("CHOG_BANK_AUTHORIZE_WALLETS", string("")))) != keccak256(bytes(BROADCAST_PHRASE))) {
            revert BroadcastDisabled();
        }
        if (GENESIS.code.length == 0) revert CodeMissing();
        uint256 tokenId = vm.envUint("CHOG_BANK_DEMO_TOKEN_ID");
        uint256 agentKey = vm.envUint("CHOG_WALLET_AGENT_KEY");
        address agent = vm.addr(agentKey);
        if (agent != vm.envAddress("CHOG_WALLET_AGENT")) revert BadSigner();

        DeployCitizenAccountFactoryV3 predicted = new DeployCitizenAccountFactoryV3();
        address expectedImpl = predicted.predictImplementation(agent);
        address expectedFactory = predicted.predictFactory(agent);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 decisionId = keccak256(abi.encode("chogos.wallet.issue.v3", block.chainid, GENESIS, tokenId));
        bytes memory signature = _sign(agentKey, expectedFactory, tokenId, decisionId, deadline);

        vm.startBroadcast();
        address implementation = _create2(predicted.IMPLEMENTATION_SALT(), predicted.implementationInitCode(agent));
        if (implementation != expectedImpl) revert DeployFailed();
        address factory = _create2(predicted.FACTORY_SALT(), predicted.factoryInitCode(agent));
        if (factory != expectedFactory) revert DeployFailed();
        wallet = CitizenAccountFactoryV3(factory).create(block.chainid, GENESIS, tokenId, decisionId, deadline, signature);
        vm.stopBroadcast();

        if (wallet != predicted.predictAccount(block.chainid, GENESIS, tokenId, agent) || wallet.code.length == 0) {
            revert DeployFailed();
        }
        console2.log("Citizen wallet deployed. This is not a funding address:");
        console2.logAddress(wallet);
        console2.log("Factory (not a funding address):");
        console2.logAddress(factory);
    }

    function _sign(uint256 agentKey, address factory, uint256 tokenId, bytes32 decisionId, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("chogOS CitizenWalletFactory"),
                keccak256("3"),
                block.chainid,
                factory
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Issuance(uint256 chainId,address nftContract,uint256 tokenId,bytes32 decisionId,uint256 deadline)"),
                block.chainid,
                GENESIS,
                tokenId,
                decisionId,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _create2(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        deployed = vm.computeCreate2Address(salt, keccak256(initCode));
        if (deployed.code.length != 0) return deployed;
        (bool ok,) = DETERMINISTIC_CREATE2.call(abi.encodePacked(salt, initCode));
        if (!ok || deployed.code.length == 0) revert DeployFailed();
    }
}
