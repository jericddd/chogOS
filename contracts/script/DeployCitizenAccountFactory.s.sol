// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {CitizenAccountFactory} from "../src/CitizenAccountFactory.sol";

/// @dev Local/simulated deploy helper. Do not pass --broadcast until Testnet is approved.
contract DeployCitizenAccountFactory is Script {
    function run() external returns (CitizenAccountFactory factory) {
        vm.startBroadcast();
        factory = new CitizenAccountFactory();
        vm.stopBroadcast();
    }
}
