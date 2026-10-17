// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenAccount
/// @notice V1 NFT-bound account for one (chain, NFT contract, token id).
/// Root authority is the current ERC-721 owner, read with ownerOf at call time.
/// Delegated grants are disabled: Chog Genesis exposes no ownership-change
/// counter and does not callback this account on Transfer, so ownerAtGrant
/// cannot permanently invalidate a grant after A→B→A. V2 may add grants only
/// with a mechanism that actually observes transfers. The AI model never
/// holds a key. This is not the Civilization Treasury.
interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract CitizenAccount {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error NotNftOwner();
    error SelectorNotAllowed();
    error Reentrant();
    error DelegationDisabled();

    event Executed(address indexed caller, address indexed target, uint256 value, bytes4 selector);

    uint256 public immutable boundChainId;
    address public immutable nftContract;
    uint256 public immutable tokenId;

    uint256 public ownerNonce;
    uint256 private locked;

    constructor(uint256 chainId_, address nftContract_, uint256 tokenId_) {
        if (chainId_ == 0) revert ZeroChain();
        if (chainId_ != block.chainid) revert WrongChain();
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

    /// @dev V1: disabled. ownerAtGrant is not a transfer detector.
    function grantDelegation(address, address, bytes4, bool, uint64) external pure returns (uint256) {
        revert DelegationDisabled();
    }

    /// @dev V1: disabled.
    function revokeDelegation(uint256) external pure {
        revert DelegationDisabled();
    }

    /// @dev V1: disabled. A grant that only snapshots the owner address
    /// becomes executable again if that address reacquires the NFT.
    function executeDelegated(uint256, uint256, address, uint256, bytes calldata)
        external
        payable
        returns (bytes memory)
    {
        revert DelegationDisabled();
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
