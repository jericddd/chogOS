// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CitizenAccountV2} from "../src/CitizenAccountV2.sol";

/// @dev Upgrade fixture. Adds no storage. Proves a new implementation can run
/// at the same proxy address.
contract CitizenAccountV2Patch is CitizenAccountV2 {
    function codeVersion() public pure override returns (uint256) {
        return 2;
    }
}
