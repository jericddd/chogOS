// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenWalletProxy
/// @notice Permanent citizen wallet. The implementation is fixed in this
/// bytecode. There is no upgrade function. Writing the ERC-1967 slot does
/// not change which code this wallet runs.
contract CitizenWalletProxy {
    /// @dev Stored for explorers. The fallback does not read it.
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address public immutable logic;

    error EmptyImplementation();

    constructor(address implementation_, bytes memory initData) payable {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert EmptyImplementation();
        logic = implementation_;
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation_)
        }
        (bool ok, bytes memory result) = implementation_.delegatecall(initData);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @notice Code this wallet runs. Reads the immutable, not the ERC-1967 slot.
    function implementation() external view returns (address) {
        return logic;
    }

    receive() external payable {}

    fallback() external payable {
        address impl = logic;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }
}
