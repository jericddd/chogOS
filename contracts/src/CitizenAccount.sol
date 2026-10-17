// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenAccount
/// @notice NFT-bound smart account for a single (chain, NFT contract, token id).
/// The current ERC-721 owner is the root authority, read at execution time.
/// Delegated executors may only hit an explicit target and selector, and a
/// transfer of the NFT invalidates existing delegations. This contract does
/// not hold a language-model key and is not a Civilization Treasury.
interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract CitizenAccount {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error NotNftOwner();
    error DelegationInvalid();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error ValueNotAllowed();
    error Replay();
    error Reentrant();
    error Expired();

    event Executed(address indexed caller, address indexed target, uint256 value, bytes4 selector);
    event DelegationGranted(
        uint256 indexed id,
        address indexed executor,
        address indexed target,
        bytes4 selector,
        bool allowValue,
        uint64 expiresAt,
        address ownerAtGrant
    );
    event DelegationRevoked(uint256 indexed id, address indexed owner);

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

    uint256 public immutable boundChainId;
    address public immutable nftContract;
    uint256 public immutable tokenId;

    uint256 public ownerNonce;
    uint256 public nextDelegationId;
    mapping(uint256 => Delegation) public delegations;

    uint256 private locked;

    constructor(uint256 chainId_, address nftContract_, uint256 tokenId_) {
        if (chainId_ == 0) revert ZeroChain();
        if (nftContract_ == address(0)) revert ZeroAddress();
        boundChainId = chainId_;
        nftContract = nftContract_;
        tokenId = tokenId_;
    }

    receive() external payable {}

    function currentOwner() public view returns (address) {
        return IERC721OwnerOf(nftContract).ownerOf(tokenId);
    }

    function token() external view returns (uint256, address, uint256) {
        return (boundChainId, nftContract, tokenId);
    }

    function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        _requireNftOwner();
        ownerNonce += 1;
        bytes memory result = _call(target, value, data);
        emit Executed(msg.sender, target, value, _selector(data));
        return result;
    }

    function grantDelegation(
        address executor,
        address target,
        bytes4 selector,
        bool allowValue,
        uint64 expiresAt
    ) external returns (uint256 id) {
        _requireNftOwner();
        if (executor == address(0) || target == address(0)) revert ZeroAddress();
        if (selector == bytes4(0)) revert SelectorNotAllowed();
        if (expiresAt <= block.timestamp) revert Expired();
        id = ++nextDelegationId;
        address owner = msg.sender;
        delegations[id] = Delegation({
            executor: executor,
            target: target,
            selector: selector,
            allowValue: allowValue,
            expiresAt: expiresAt,
            ownerAtGrant: owner,
            revoked: false,
            nonce: 0
        });
        emit DelegationGranted(id, executor, target, selector, allowValue, expiresAt, owner);
    }

    function revokeDelegation(uint256 id) external {
        _requireNftOwner();
        Delegation storage item = delegations[id];
        if (item.executor == address(0)) revert DelegationInvalid();
        item.revoked = true;
        emit DelegationRevoked(id, msg.sender);
    }

    function executeDelegated(
        uint256 id,
        uint256 expectedNonce,
        address target,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory) {
        if (block.chainid != boundChainId) revert WrongChain();
        Delegation storage item = delegations[id];
        if (item.revoked || item.executor == address(0) || item.executor != msg.sender) {
            revert DelegationInvalid();
        }
        if (block.timestamp >= item.expiresAt) revert Expired();
        if (item.ownerAtGrant != currentOwner()) revert NotNftOwner();
        if (item.nonce != expectedNonce) revert Replay();
        if (target != item.target) revert TargetNotAllowed();
        if (value != 0 && !item.allowValue) revert ValueNotAllowed();
        if (_selector(data) != item.selector) revert SelectorNotAllowed();
        item.nonce += 1;
        bytes memory result = _call(target, value, data);
        emit Executed(msg.sender, target, value, item.selector);
        return result;
    }

    function _requireNftOwner() internal view {
        if (block.chainid != boundChainId) revert WrongChain();
        if (msg.sender != currentOwner()) revert NotNftOwner();
    }

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        if (data.length < 4) revert SelectorNotAllowed();
        return bytes4(data[0:4]);
    }

    function _call(address target, uint256 value, bytes calldata data) internal returns (bytes memory) {
        if (target == address(0)) revert ZeroAddress();
        if (locked == 1) revert Reentrant();
        locked = 1;
        (bool ok, bytes memory result) = target.call{value: value}(data);
        locked = 0;
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
