// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Local ERC-721 ownerOf stub. Not Chog Genesis. Not for Mainnet.
contract MockGenesisNFT {
    error NotOwner();
    error NotApproved();
    error Exists();
    error ZeroAddress();
    error UnsafeReceiver();

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 tokenId) external {
        if (to == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != address(0)) revert Exists();
        ownerOf[tokenId] = to;
    }

    function approve(address spender, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        if (msg.sender != owner && !isApprovedForAll[owner][msg.sender]) revert NotApproved();
        getApproved[tokenId] = spender;
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        isApprovedForAll[msg.sender][operator] = approved;
    }

    /// @dev Kept for the V1.1 tests. The owner moves the token directly.
    function transfer(address to, uint256 tokenId) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwner();
        _move(to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf[tokenId];
        if (owner != from) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != owner && msg.sender != getApproved[tokenId] && !isApprovedForAll[owner][msg.sender]) {
            revert NotApproved();
        }
        _move(to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId);
    }

    function _move(address to, uint256 tokenId) internal {
        if (to == address(0)) revert ZeroAddress();
        getApproved[tokenId] = address(0);
        ownerOf[tokenId] = to;
    }

    function _checkReceiver(address from, address to, uint256 tokenId) internal {
        if (to.code.length == 0) return;
        (bool ok, bytes memory data) = to.call(
            abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", msg.sender, from, tokenId, "")
        );
        bytes4 expected = bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));
        if (!ok || data.length < 32 || bytes4(data) != expected) revert UnsafeReceiver();
    }
}

contract MockSink {
    uint256 public lastValue;
    address public lastCaller;

    function ping(uint256 value) external payable {
        lastValue = value;
        lastCaller = msg.sender;
    }

    function fail() external pure {
        revert("sink-failed");
    }
}
