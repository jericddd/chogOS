// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ChogBank} from "../src/ChogBank.sol";

/// @notice One manual payout. The Next.js app cannot call this.
/// `run()` reverts unless chain id is 143 and CHOG_BANK_AUTHORIZE_PAYOUT is the phrase below.
/// The authorizer key is read from a file path outside the repository. It is not an application environment variable.
/// Forge's broadcast key pays gas. It should be a different keystore from the authorizer file.
contract ChogBankPayout is Script {
    string public constant PAYOUT_PHRASE = "yes-broadcast-one-chogbank-payout";

    error BroadcastDisabled();
    error WrongChain();
    error CodeMissing();
    error BadSigner();
    error BadAsset();

    function digest() external {
        (ChogBank bank, bytes32 decisionId, uint256 tokenId, address asset, uint256 amount, uint256 deadline, bytes32 reasonHash) =
            _params();
        console2.log("Sign this exact 32-byte digest. Do not use an Ethereum personal-sign prefix:");
        console2.logBytes32(bank.allocationDigest(decisionId, tokenId, asset, amount, deadline, reasonHash));
        console2.log("Recipient wallet, not a funding address:");
        console2.logAddress(bank.payoutRecipient(tokenId));
    }

    function run() external {
        if (block.chainid != 143) revert WrongChain();
        if (keccak256(bytes(vm.envOr("CHOG_BANK_AUTHORIZE_PAYOUT", string("")))) != keccak256(bytes(PAYOUT_PHRASE))) {
            revert BroadcastDisabled();
        }
        (ChogBank bank, bytes32 decisionId, uint256 tokenId, address asset, uint256 amount, uint256 deadline, bytes32 reasonHash) =
            _params();
        address recipient = bank.payoutRecipient(tokenId);
        uint256 key = vm.parseUint(vm.readLine(vm.envString("CHOG_BANK_AUTHORIZER_KEYFILE")));
        if (vm.addr(key) != bank.authorizer()) revert BadSigner();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bank.allocationDigest(decisionId, tokenId, asset, amount, deadline, reasonHash));
        vm.startBroadcast();
        bank.distribute(decisionId, tokenId, asset, amount, deadline, reasonHash, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
        console2.log("Submitted. Confirm a Distributed event before calling this a payment. Recipient:");
        console2.logAddress(recipient);
    }

    function _params()
        internal
        view
        returns (ChogBank bank, bytes32 decisionId, uint256 tokenId, address asset, uint256 amount, uint256 deadline, bytes32 reasonHash)
    {
        bank = ChogBank(payable(vm.envAddress("CHOG_BANK_CONTRACT_ADDRESS")));
        if (address(bank).code.length == 0) revert CodeMissing();
        decisionId = vm.envBytes32("CHOG_BANK_DECISION_ID");
        tokenId = vm.envUint("CHOG_BANK_TOKEN_ID");
        asset = _asset();
        amount = vm.envUint("CHOG_BANK_AMOUNT_WEI");
        deadline = vm.envUint("CHOG_BANK_DEADLINE");
        reasonHash = vm.envBytes32("CHOG_BANK_REASON_HASH");
    }

    function _asset() internal view returns (address) {
        string memory label = vm.envString("CHOG_BANK_ASSET");
        if (keccak256(bytes(label)) == keccak256("MON")) return address(0);
        if (keccak256(bytes(label)) == keccak256("CHOG")) return vm.envAddress("CHOG_BANK_CHOG_ADDRESS");
        revert BadAsset();
    }
}
