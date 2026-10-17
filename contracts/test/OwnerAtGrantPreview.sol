// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CitizenAccount} from "../src/CitizenAccount.sol";

/// @dev Test-only copy of the rejected ownerAtGrant check. Not V1. Not deployed.
/// Proves that snapshotting the owner address is only "invalid while someone
/// else holds the NFT", not "permanently invalidated by any transfer".
contract OwnerAtGrantPreview {
    error DelegationInvalid();
    error NotNftOwner();
    error Replay();
    error Expired();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error ValueNotAllowed();

    struct Delegation {
        address executor;
        address target;
        bytes4 selector;
        bool allowValue;
        uint64 expiresAt;
        address ownerAtGrant;
        bool revoked;
        uint256 nonce;
    }

    CitizenAccount public immutable account;
    uint256 public nextDelegationId;
    mapping(uint256 => Delegation) public delegations;

    constructor(CitizenAccount account_) {
        account = account_;
    }

    function grant(address executor, address target, bytes4 selector, bool allowValue, uint64 expiresAt)
        external
        returns (uint256 id)
    {
        if (msg.sender != account.currentOwner()) revert NotNftOwner();
        if (expiresAt <= block.timestamp) revert Expired();
        id = ++nextDelegationId;
        delegations[id] = Delegation({
            executor: executor,
            target: target,
            selector: selector,
            allowValue: allowValue,
            expiresAt: expiresAt,
            ownerAtGrant: msg.sender,
            revoked: false,
            nonce: 0
        });
    }

    function revoke(uint256 id) external {
        if (msg.sender != account.currentOwner()) revert NotNftOwner();
        Delegation storage item = delegations[id];
        if (item.executor == address(0)) revert DelegationInvalid();
        item.revoked = true;
    }

    function executeDelegated(uint256 id, uint256 expectedNonce, address target, uint256 value, bytes calldata data)
        external
        payable
    {
        Delegation storage item = delegations[id];
        if (item.revoked || item.executor == address(0) || item.executor != msg.sender) revert DelegationInvalid();
        if (block.timestamp >= item.expiresAt) revert Expired();
        if (item.ownerAtGrant != account.currentOwner()) revert NotNftOwner();
        if (item.nonce != expectedNonce) revert Replay();
        if (target != item.target) revert TargetNotAllowed();
        if (value != 0 && !item.allowValue) revert ValueNotAllowed();
        if (data.length < 4 || bytes4(data[0:4]) != item.selector) revert SelectorNotAllowed();
        item.nonce += 1;
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
