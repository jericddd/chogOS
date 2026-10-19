// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CitizenAccountV2} from "./CitizenAccountV2.sol";
import {CitizenWalletProxy} from "./CitizenWalletProxy.sol";

/// @title CitizenAccountFactoryV2
/// @notice CREATE2 factory for permanent citizen wallets.
/// One proxy per (chain id, NFT contract, token id). The proxy address is
/// the wallet and stays the same when its implementation is upgraded.
/// The implementation address is part of this factory's creation code, so
/// this factory address is not the V1 or V1.1 factory address.
/// A predicted address is not a deployed wallet. create() is idempotent.
/// create() refuses a chain id other than the chain it is executed on.
/// This factory is not deployed.
contract CitizenAccountFactoryV2 {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error BadImplementation();

    event AccountCreated(address indexed account, uint256 chainId, address nftContract, uint256 tokenId);

    address public immutable implementation;
    mapping(bytes32 => address) public deployed;

    constructor(address implementation_) {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert BadImplementation();
        (bool ok, bytes memory data) = implementation_.staticcall(abi.encodeWithSignature("codeVersion()"));
        if (!ok || data.length != 32 || abi.decode(data, (uint256)) != 1) revert BadImplementation();
        implementation = implementation_;
    }

    function accountSalt(uint256 chainId, address nftContract, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, nftContract, tokenId));
    }

    function predict(uint256 chainId, address nftContract, uint256 tokenId) public view returns (address) {
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        bytes memory initData = abi.encodeCall(CitizenAccountV2.initialize, (chainId, nftContract, tokenId));
        bytes32 initHash = keccak256(
            abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(implementation, initData))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function create(uint256 chainId, address nftContract, uint256 tokenId) external returns (address account) {
        if (chainId == 0) revert ZeroChain();
        if (chainId != block.chainid) revert WrongChain();
        if (nftContract == address(0)) revert ZeroAddress();
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        address existing = deployed[salt];
        if (existing != address(0)) return existing;
        address predicted = predict(chainId, nftContract, tokenId);
        if (predicted.code.length != 0) {
            deployed[salt] = predicted;
            return predicted;
        }
        bytes memory initData = abi.encodeCall(CitizenAccountV2.initialize, (chainId, nftContract, tokenId));
        account = address(new CitizenWalletProxy{salt: salt}(implementation, initData));
        deployed[salt] = account;
        emit AccountCreated(account, chainId, nftContract, tokenId);
    }
}
