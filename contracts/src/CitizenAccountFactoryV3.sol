// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CitizenAccountV3} from "./CitizenAccountV3.sol";
import {CitizenWalletProxy} from "./CitizenWalletProxy.sol";

/// @title CitizenAccountFactoryV3
/// @notice CREATE2 factory for AI-issued citizen wallets.
/// The address is fixed by this factory, the implementation, the chain, the
/// Genesis contract, and the token id. The first deployment requires an
/// agent signature. Anyone can relay that signature. A second call returns
/// the same wallet and does not create another one.
/// Deployed on Monad mainnet at 0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A.
/// The agent key is not in this repository.
contract CitizenAccountFactoryV3 {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error BadImplementation();
    error BadAction();
    error Expired();
    error DeadlineTooFar();
    error Replay();
    error BadSigner();

    event AccountCreated(address indexed account, uint256 chainId, address nftContract, uint256 tokenId, bytes32 decisionId);

    uint256 internal constant MAX_TTL = 1 days;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("chogOS CitizenWalletFactory");
    bytes32 private constant VERSION_HASH = keccak256("3");
    bytes32 private constant ISSUANCE_TYPEHASH = keccak256(
        "Issuance(uint256 chainId,address nftContract,uint256 tokenId,bytes32 decisionId,uint256 deadline)"
    );
    bytes32 private constant SECP256K1_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable implementation;
    address public immutable agent;
    mapping(bytes32 => address) public deployed;
    mapping(bytes32 => bool) public usedIssuance;

    constructor(address implementation_) {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert BadImplementation();
        (bool versionOk, bytes memory versionData) = implementation_.staticcall(abi.encodeWithSignature("codeVersion()"));
        if (!versionOk || versionData.length != 32 || abi.decode(versionData, (uint256)) != 3) revert BadImplementation();
        (bool agentOk, bytes memory agentData) = implementation_.staticcall(abi.encodeWithSignature("agent()"));
        if (!agentOk || agentData.length != 32) revert BadImplementation();
        address agent_ = abi.decode(agentData, (address));
        if (agent_ == address(0)) revert BadImplementation();
        implementation = implementation_;
        agent = agent_;
    }

    function accountSalt(uint256 chainId, address nftContract, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, nftContract, tokenId));
    }

    function predict(uint256 chainId, address nftContract, uint256 tokenId) public view returns (address) {
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        bytes memory initData = abi.encodeCall(CitizenAccountV3.initialize, (chainId, nftContract, tokenId));
        bytes32 initHash = keccak256(abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(implementation, initData)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function issuanceDigest(uint256 chainId, address nftContract, uint256 tokenId, bytes32 decisionId, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 structHash = keccak256(abi.encode(ISSUANCE_TYPEHASH, chainId, nftContract, tokenId, decisionId, deadline));
        return keccak256(abi.encodePacked(bytes2(0x1901), domain, structHash));
    }

    function create(
        uint256 chainId,
        address nftContract,
        uint256 tokenId,
        bytes32 decisionId,
        uint256 deadline,
        bytes calldata signature
    ) external returns (address account) {
        if (chainId == 0) revert ZeroChain();
        if (chainId != block.chainid) revert WrongChain();
        if (nftContract == address(0)) revert ZeroAddress();
        bytes32 salt = accountSalt(chainId, nftContract, tokenId);
        address existing = deployed[salt];
        if (existing != address(0)) return existing;
        address predicted = predict(chainId, nftContract, tokenId);
        if (predicted.code.length != 0) {
            if (!_matches(predicted, chainId, nftContract, tokenId)) revert BadImplementation();
            deployed[salt] = predicted;
            return predicted;
        }
        _requireIssuance(chainId, nftContract, tokenId, decisionId, deadline, signature);
        usedIssuance[decisionId] = true;
        bytes memory initData = abi.encodeCall(CitizenAccountV3.initialize, (chainId, nftContract, tokenId));
        account = address(new CitizenWalletProxy{salt: salt}(implementation, initData));
        if (account != predicted || !_matches(account, chainId, nftContract, tokenId)) revert BadImplementation();
        deployed[salt] = account;
        emit AccountCreated(account, chainId, nftContract, tokenId, decisionId);
    }

    function _matches(address account, uint256 chainId, address nftContract, uint256 tokenId) private view returns (bool) {
        (bool ok, bytes memory data) = account.staticcall(abi.encodeWithSignature("token()"));
        if (!ok || data.length < 96) return false;
        (uint256 chain_, address nft_, uint256 id_) = abi.decode(data, (uint256, address, uint256));
        return chain_ == chainId && nft_ == nftContract && id_ == tokenId;
    }

    function _requireIssuance(
        uint256 chainId,
        address nftContract,
        uint256 tokenId,
        bytes32 decisionId,
        uint256 deadline,
        bytes calldata signature
    ) private view {
        if (decisionId == bytes32(0) || usedIssuance[decisionId]) revert Replay();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_TTL) revert DeadlineTooFar();
        if (signature.length != 65) revert BadSigner();
        bytes32 digest = issuanceDigest(chainId, nftContract, tokenId, decisionId, deadline);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > uint256(SECP256K1_HALF)) revert BadSigner();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSigner();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != agent) revert BadSigner();
    }
}
