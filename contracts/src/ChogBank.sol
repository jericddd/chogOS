// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CitizenAccountV3} from "./CitizenAccountV3.sol";
import {CitizenWalletProxy} from "./CitizenWalletProxy.sol";

interface ICitizenWalletFactory {
    function create(
        uint256 chainId,
        address nftContract,
        uint256 tokenId,
        bytes32 decisionId,
        uint256 deadline,
        bytes calldata signature
    ) external returns (address);
}

/// @title ChogBank
/// @notice Ownerless treasury for native MON and one pinned ERC-20, intended to be the official $CHOG token.
/// There is no owner, administrator, proxy, upgrade path, rescue, or delegatecall.
/// The immutable authorizer can sign an allocation. The signature is not enough:
/// the contract still enforces the asset, the caps, the expiry, the nonce, and the recipient.
/// The recipient is only the permanent citizen wallet for one Chog Genesis token id.
/// If that wallet has no code, the transfer reverts. An empty predicted address is never paid.
/// The wallet does not have to hold the NFT. NFT ownership is not an authorization.
/// A leaked authorizer key can spend only inside these caps, and only to those wallets.
/// It cannot change this contract or withdraw to an arbitrary address.
/// Deployed on Monad mainnet at 0xB2494538433B2FA3167A723d32329cc22c3A59C1.
/// A new deployment of this file is a different address. This constructor does not deploy citizen wallets.
contract ChogBank {
    error WrongChain();
    error ZeroAddress();
    error CodeMissing();
    error SharedAddress();
    error BadWindow();
    error BadTtl();
    error CapRequired();
    error CapTooLarge();
    error CapOrder();
    error Reentrancy();
    error ZeroAmount();
    error UnsupportedAsset();
    error Expired();
    error DeadlineTooFar();
    error Replay();
    error BadSigner();
    error PerTxCap();
    error CitizenCap();
    error AggregateCap();
    error InsufficientBalance();
    error WalletNotDeployed();
    error InvalidRecipient();
    error TransferFailed();

    event Funded(address indexed from, address indexed asset, uint256 amount);
    event Distributed(
        bytes32 indexed decisionId,
        uint256 indexed tokenId,
        address indexed recipient,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reasonHash
    );

    uint256 private constant UNLOCKED = 1;
    uint256 private constant LOCKED = 2;
    uint256 private constant MAX_CAP = type(uint128).max;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("chogOS ChogBank");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant ALLOCATION_TYPEHASH = keccak256(
        "Allocation(bytes32 decisionId,uint256 tokenId,address asset,uint256 amount,uint256 deadline,bytes32 reasonHash)"
    );
    bytes32 private constant SECP256K1_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct IssuancePermit {
        bytes32 decisionId;
        uint256 deadline;
        bytes signature;
    }

    struct Init {
        address genesis;
        address chogToken;
        address walletFactory;
        address walletImplementation;
        address authorizer;
        uint256 windowSeconds;
        uint256 maxAuthorizationTtl;
        uint256 maxPerTxMon;
        uint256 maxCitizenWindowMon;
        uint256 maxAggregateWindowMon;
        uint256 maxPerTxChog;
        uint256 maxCitizenWindowChog;
        uint256 maxAggregateWindowChog;
    }

    uint256 public immutable configuredChainId;
    address public immutable genesis;
    address public immutable chogToken;
    address public immutable walletFactory;
    address public immutable walletImplementation;
    address public immutable authorizer;

    /// @dev Written once in the constructor. No function changes these values.
    uint256 public windowSeconds;
    uint256 public maxAuthorizationTtl;
    uint256 public maxPerTxMon;
    uint256 public maxCitizenWindowMon;
    uint256 public maxAggregateWindowMon;
    uint256 public maxPerTxChog;
    uint256 public maxCitizenWindowChog;
    uint256 public maxAggregateWindowChog;

    uint256 private lock;
    mapping(bytes32 => bool) public usedDecision;
    mapping(bytes32 => uint256) public spentInWindow;
    mapping(bytes32 => uint256) public spentByCitizen;

    constructor(Init memory init) {
        if (block.chainid != 143) revert WrongChain();
        _checkInit(init);
        configuredChainId = block.chainid;
        genesis = init.genesis;
        chogToken = init.chogToken;
        walletFactory = init.walletFactory;
        walletImplementation = init.walletImplementation;
        authorizer = init.authorizer;
        windowSeconds = init.windowSeconds;
        maxAuthorizationTtl = init.maxAuthorizationTtl;
        maxPerTxMon = init.maxPerTxMon;
        maxCitizenWindowMon = init.maxCitizenWindowMon;
        maxAggregateWindowMon = init.maxAggregateWindowMon;
        maxPerTxChog = init.maxPerTxChog;
        maxCitizenWindowChog = init.maxCitizenWindowChog;
        maxAggregateWindowChog = init.maxAggregateWindowChog;
        lock = UNLOCKED;
    }

    function _checkInit(Init memory init) private view {
        if (
            init.genesis == address(0) || init.chogToken == address(0) || init.walletFactory == address(0)
                || init.walletImplementation == address(0) || init.authorizer == address(0)
        ) revert ZeroAddress();
        if (init.genesis.code.length == 0 || init.chogToken.code.length == 0) revert CodeMissing();
        if (_shared(init.genesis, init.chogToken, init.walletFactory, init.walletImplementation, init.authorizer)) {
            revert SharedAddress();
        }
        if (init.windowSeconds < 1 hours || init.windowSeconds > 30 days) revert BadWindow();
        if (init.maxAuthorizationTtl < 15 minutes || init.maxAuthorizationTtl > init.windowSeconds) revert BadTtl();
        _requireCaps(init.maxPerTxMon, init.maxCitizenWindowMon, init.maxAggregateWindowMon);
        _requireCaps(init.maxPerTxChog, init.maxCitizenWindowChog, init.maxAggregateWindowChog);
    }

    function _shared(address a, address b, address c, address d, address e) private pure returns (bool) {
        return a == b || a == c || a == d || a == e || b == c || b == d || b == e || c == d || c == e || d == e;
    }

    /// @dev Native MON funding. No approval and no caller allowlist.
    receive() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Funded(msg.sender, address(0), msg.value);
    }

    /// @notice Pull official-token funding. A plain token transfer also increases the balance.
    /// The plain transfer is visible on the token contract. This function emits Funded for the amount received.
    function depositChog(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBalance = _tokenBalance(chogToken);
        _safeTransferFrom(chogToken, msg.sender, address(this), amount);
        uint256 received = _tokenBalance(chogToken) - beforeBalance;
        if (received == 0) revert TransferFailed();
        emit Funded(msg.sender, chogToken, received);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, configuredChainId, address(this)));
    }

    function allocationDigest(
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reasonHash
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ALLOCATION_TYPEHASH, decisionId, tokenId, asset, amount, deadline, reasonHash)
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash));
    }

    /// @notice Permanent wallet for this token id. The address is empty until that wallet is created.
    /// Changing the NFT holder does not change this address.
    function citizenWallet(uint256 tokenId) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(configuredChainId, genesis, tokenId));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), walletFactory, salt, walletInitHash(tokenId))))));
    }

    function walletInitHash(uint256 tokenId) public view returns (bytes32) {
        bytes memory initData = abi.encodeCall(CitizenAccountV3.initialize, (configuredChainId, genesis, tokenId));
        return keccak256(abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(walletImplementation, initData)));
    }

    function distribute(
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reasonHash,
        bytes calldata signature
    ) external nonReentrant {
        _checkFresh(decisionId, amount, deadline, asset);
        _requireAuthorizer(allocationDigest(decisionId, tokenId, asset, amount, deadline, reasonHash), signature);
        _reserve(decisionId, tokenId, asset, amount);
        address recipient = payoutRecipient(tokenId);
        _pay(asset, recipient, amount);
        emit Distributed(decisionId, tokenId, recipient, asset, amount, deadline, reasonHash);
    }

    /// @notice Create the citizen wallet, when it has no code, and then pay it.
    /// The issuance signature is checked by the factory. It is not a treasury signature.
    /// A failed create reverts this call, so the allocation is not recorded as paid.
    function distributeWithIssuance(
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reasonHash,
        bytes calldata signature,
        IssuancePermit calldata issuance
    ) external nonReentrant {
        _checkFresh(decisionId, amount, deadline, asset);
        _requireAuthorizer(allocationDigest(decisionId, tokenId, asset, amount, deadline, reasonHash), signature);
        _reserve(decisionId, tokenId, asset, amount);
        address recipient = _ensureWallet(tokenId, issuance);
        _requireWalletIdentity(recipient, tokenId);
        _pay(asset, recipient, amount);
        emit Distributed(decisionId, tokenId, recipient, asset, amount, deadline, reasonHash);
    }

    function _checkFresh(bytes32 decisionId, uint256 amount, uint256 deadline, address asset) private view {
        if (decisionId == bytes32(0) || usedDecision[decisionId]) revert Replay();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + maxAuthorizationTtl) revert DeadlineTooFar();
        if (asset != address(0) && asset != chogToken) revert UnsupportedAsset();
    }

    function _reserve(bytes32 decisionId, uint256 tokenId, address asset, uint256 amount) private {
        uint256 perTx = asset == address(0) ? maxPerTxMon : maxPerTxChog;
        uint256 perCitizen = asset == address(0) ? maxCitizenWindowMon : maxCitizenWindowChog;
        uint256 aggregate = asset == address(0) ? maxAggregateWindowMon : maxAggregateWindowChog;
        if (amount > perTx) revert PerTxCap();
        uint256 windowId = block.timestamp / windowSeconds;
        bytes32 windowKey = keccak256(abi.encode(asset, windowId));
        bytes32 citizenKey = keccak256(abi.encode(asset, windowId, tokenId));
        uint256 nextCitizen = spentByCitizen[citizenKey] + amount;
        uint256 nextWindow = spentInWindow[windowKey] + amount;
        if (nextCitizen > perCitizen) revert CitizenCap();
        if (nextWindow > aggregate) revert AggregateCap();
        uint256 available = asset == address(0) ? address(this).balance : _tokenBalance(chogToken);
        if (available < amount) revert InsufficientBalance();
        usedDecision[decisionId] = true;
        spentByCitizen[citizenKey] = nextCitizen;
        spentInWindow[windowKey] = nextWindow;
    }

    /// @notice Recipient used by distribute. Reverts when the wallet is missing or is not this citizen.
    /// An empty predicted address is never paid. NFT custody is not required.
    function payoutRecipient(uint256 tokenId) public view returns (address recipient) {
        recipient = citizenWallet(tokenId);
        if (recipient == address(this) || recipient == authorizer || recipient == chogToken || recipient == genesis) {
            revert InvalidRecipient();
        }
        if (recipient.code.length == 0) revert WalletNotDeployed();
        _requireWalletIdentity(recipient, tokenId);
    }

    function _ensureWallet(uint256 tokenId, IssuancePermit calldata issuance) private returns (address recipient) {
        recipient = citizenWallet(tokenId);
        if (recipient.code.length != 0) return recipient;
        ICitizenWalletFactory(walletFactory).create(
            configuredChainId, genesis, tokenId, issuance.decisionId, issuance.deadline, issuance.signature
        );
        if (recipient.code.length == 0) revert WalletNotDeployed();
    }

    function _requireWalletIdentity(address recipient, uint256 tokenId) private view {
        (bool ok, bytes memory data) = recipient.staticcall(abi.encodeWithSignature("token()"));
        if (!ok || data.length < 96) revert InvalidRecipient();
        (uint256 chainId_, address nft_, uint256 id_) = abi.decode(data, (uint256, address, uint256));
        if (chainId_ != configuredChainId || nft_ != genesis || id_ != tokenId) revert InvalidRecipient();
        (bool versionOk, bytes memory versionData) = recipient.staticcall(abi.encodeWithSignature("codeVersion()"));
        if (!versionOk || versionData.length < 32 || abi.decode(versionData, (uint256)) != 3) revert InvalidRecipient();
    }

    function _pay(address asset, address recipient, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferFailed();
            return;
        }
        uint256 beforeBalance = _tokenBalance(chogToken);
        _safeTransfer(chogToken, recipient, amount);
        if (beforeBalance - _tokenBalance(chogToken) != amount) revert TransferFailed();
    }

    function _requireCaps(uint256 perTx, uint256 perCitizen, uint256 aggregate) private pure {
        if (perTx == 0 || perCitizen == 0 || aggregate == 0) revert CapRequired();
        if (perTx > MAX_CAP || perCitizen > MAX_CAP || aggregate > MAX_CAP) revert CapTooLarge();
        if (perTx > perCitizen || perCitizen > aggregate) revert CapOrder();
    }

    function _requireAuthorizer(bytes32 digest, bytes calldata signature) private view {
        if (signature.length != 65) revert BadSigner();
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
        if (signer == address(0) || signer != authorizer) revert BadSigner();
    }

    function _tokenBalance(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(bytes4(keccak256("balanceOf(address)")), address(this)));
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    modifier nonReentrant() {
        if (lock != UNLOCKED) revert Reentrancy();
        lock = LOCKED;
        _;
        lock = UNLOCKED;
    }
}
