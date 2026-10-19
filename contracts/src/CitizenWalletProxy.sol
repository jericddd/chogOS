// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenWalletProxy
/// @notice ERC-1967 proxy. This address is the permanent citizen wallet.
/// Replacing the implementation does not change the address, the stored
/// identity, or the assets held here.
contract CitizenWalletProxy {
    /// @dev ERC-1967 implementation slot.
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error EmptyImplementation();

    constructor(address implementation, bytes memory initData) payable {
        if (implementation == address(0) || implementation.code.length == 0) revert EmptyImplementation();
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        (bool ok, bytes memory result) = implementation.delegatecall(initData);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {}

    fallback() external payable {
        assembly {
            let impl := sload(IMPLEMENTATION_SLOT)
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
