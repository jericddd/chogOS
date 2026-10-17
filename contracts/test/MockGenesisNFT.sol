// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Local ERC-721 ownerOf stub. Not Chog Genesis. Not for Mainnet.
contract MockGenesisNFT {
    error NotOwner();
    error Exists();
    error ZeroAddress();

    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 tokenId) external {
        if (to == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != address(0)) revert Exists();
        ownerOf[tokenId] = to;
    }

    function transfer(address to, uint256 tokenId) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        ownerOf[tokenId] = to;
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
