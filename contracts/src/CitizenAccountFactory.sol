// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CitizenAccount} from "./CitizenAccount.sol";

/// @title CitizenAccountFactory
/// @notice CREATE2 factory. One account per (chainId, nft contract, token id).
/// No constructor arguments. Account address =
/// keccak256(0xff ++ address(this) ++ salt ++ keccak256(creationCode ++ abi.encode(args)))
/// where salt = keccak256(abi.encode(chainId, nftContract, tokenId)).
/// A predicted address is not a deployed account. create() is idempotent.
/// create() refuses chainId != block.chainid, so Mainnet accounts cannot be
/// created from a Testnet factory and the reverse.
contract CitizenAccountFactory {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();

    event AccountCreated(address indexed account, uint256 chainId, address nftContract, uint256 tokenId);

    mapping(bytes32 => address) public deployed;

    function accountSalt(uint256 chainId, address nftContract, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, nftContract, tokenId));
    }

    function predict(uint256 chainId, address nftContract, uint256 tokenId) public view returns (address) {
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(CitizenAccount).creationCode, abi.encode(chainId, nftContract, tokenId))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    function create(uint256 chainId, address nftContract, uint256 tokenId) external returns (address account) {
        if (chainId == 0) revert ZeroChain();
        if (chainId != block.chainid) revert WrongChain();
        if (nftContract == address(0)) revert ZeroAddress();
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        address existing = deployed[salt];
        if (existing != address(0)) {
            return existing;
        }
        account = address(new CitizenAccount{salt: salt}(chainId, nftContract, tokenId));
        deployed[salt] = account;
        emit AccountCreated(account, chainId, nftContract, tokenId);
    }
}
