// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenAccountV2
/// @notice Logic for one permanent citizen wallet. Deployed behind
/// CitizenWalletProxy. The proxy address is the wallet. This contract's
/// own address is not a citizen wallet.
///
/// Five separate concerns:
/// 1. Identity and wallet address are (chain id, NFT, token id), stored once.
/// 2. Current NFT ownership is ownerOf while the human holds the NFT.
/// 3. Human authorization is that live owner, or `controller` while this
///    wallet holds the NFT through deposit().
/// 4. An AI session exists only in custody, and only while its stored epoch
///    equals `authEpoch`.
/// 5. Session calls are capped by target, selector, ETH, and one ERC-20.
///    The human path is separate and is not an AI session.
///
/// Chog Genesis has no transfer callback and no transfer counter. A session
/// that only checks the current owner cannot see Alice → Bob → Alice.
/// executeSession is therefore allowed only while this wallet holds the NFT.
/// Every exit goes through release(), which increments authEpoch before the
/// token moves. Putting the NFT back does not restore the old epoch.
/// No watcher, owner cache, or session expiry is part of that check.
///
/// An unsafe transferFrom into this wallet is not a deposit. Safe transfers
/// are rejected unless deposit() asked for the token. That untracked state
/// authorizes nobody: it does not revive a session and it does not hand the
/// assets to a previous owner.
///
/// The implementation is immutable. The current NFT holder cannot replace it.
/// An arbitrary upgrade would remain after the NFT is transferred and could
/// ignore the new owner. Pause or revoke a session, then release() the NFT,
/// before transferring it to someone else.
///
/// Nothing in this repository deploys this contract.
interface ICitizenNft {
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface ISpendToken {
    function balanceOf(address account) external view returns (uint256);
}

contract CitizenAccountV2 {
    error DirectCall();
    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error NotNftOwner();
    error NotAuthorized();
    error NotInCustody();
    error AlreadyInCustody();
    error UntrackedCustody();
    error SelectorNotAllowed();
    error Reentrant();
    error SessionDead();
    error SessionPaused();
    error SessionExpired();
    error SessionInactive();
    error StaleEpoch();
    error Replay();
    error TargetNotAllowed();
    error ValueNotAllowed();
    error SpendLimit();
    error TokenSpendLimit();
    error TokenNotAllowed();
    error ApprovalDisabled();
    error InvalidTtl();
    error InvalidLimit();
    error CustodyChanged();
    error StillHeld();
    error UnexpectedNft();

    event Deposited(address indexed controller, uint256 epoch);
    event Released(address indexed controller, address indexed to, uint256 epoch);
    event SessionOpened(
        address indexed controller,
        address indexed executor,
        address target,
        bytes4 selector,
        uint64 expiresAt,
        uint256 epoch
    );
    event SessionInvalidated(address indexed caller, uint256 epoch);
    event Executed(address indexed caller, address indexed target, uint256 value, bytes4 selector);

    struct Session {
        address executor;
        address controllerAtOpen;
        address target;
        bytes4 selector;
        uint256 maxValuePerCall;
        uint256 maxCumulativeValue;
        uint256 spent;
        address spendToken;
        uint256 maxTokenPerCall;
        uint256 maxTokenCumulative;
        uint256 tokenSpent;
        uint64 expiresAt;
        uint64 openedBlock;
        uint256 nonce;
        uint256 epoch;
        bool dead;
        bool paused;
    }

    struct SessionParams {
        address executor;
        address target;
        bytes4 selector;
        uint256 maxValuePerCall;
        uint256 maxCumulativeValue;
        address spendToken;
        uint256 maxTokenPerCall;
        uint256 maxTokenCumulative;
        uint64 ttlSeconds;
    }

    /// @dev ERC-1967 implementation slot. Not a sequential storage slot.
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant UNLOCKED = 1;
    uint256 internal constant LOCKED = 2;
    bytes4 internal constant ERC20_TRANSFER = 0xa9059cbb;
    bytes4 internal constant ERC20_TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant PERMIT = 0xd505accf;
    bytes4 internal constant DAI_PERMIT = 0x8fcbaf0c;
    bytes4 internal constant INCREASE_APPROVAL = 0xd73dd623;

    /// @dev Immutables are read from this bytecode, including during delegatecall.
    address private immutable self;

    // Sequential proxy storage. Append only. Do not reorder or insert.
    uint256 private lock;
    bool public initialized;
    uint256 public boundChainId;
    address public nftContract;
    uint256 public tokenId;
    bool public custodyOpen;
    address public controller;
    uint256 public authEpoch;
    uint256 public executionCount;
    bool private expectingReceive;
    Session internal session;
    uint256[48] private gap;

    constructor() {
        self = address(this);
        initialized = true;
        lock = UNLOCKED;
    }

    modifier onlyProxy() {
        if (address(this) == self) revert DirectCall();
        _;
    }

    modifier ready() {
        if (address(this) == self) revert DirectCall();
        if (!initialized || block.chainid != boundChainId) revert WrongChain();
        _;
    }

    modifier nonReentrant() {
        if (lock != UNLOCKED) revert Reentrant();
        lock = LOCKED;
        _;
        lock = UNLOCKED;
    }

    function codeVersion() public pure returns (uint256) {
        return 1;
    }

    function initialize(uint256 chainId_, address nft_, uint256 tokenId_) external onlyProxy {
        if (initialized) revert AlreadyInitialized();
        if (chainId_ == 0) revert ZeroChain();
        if (chainId_ != block.chainid) revert WrongChain();
        if (nft_ == address(0) || nft_.code.length == 0) revert ZeroAddress();
        initialized = true;
        lock = UNLOCKED;
        boundChainId = chainId_;
        nftContract = nft_;
        tokenId = tokenId_;
    }

    function token() external view returns (uint256, address, uint256) {
        return (boundChainId, nftContract, tokenId);
    }

    /// @dev Explorer copy of the implementation. The proxy executes its
    /// immutable `logic`, not this slot. Nothing in this contract writes it.
    function implementation() public view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    /// @notice Human authority. The controller only while deposit() is open.
    /// An untracked inbound NFT authorizes nobody.
    function authority() public view returns (address) {
        if (address(this) == self || !initialized || block.chainid != boundChainId) return address(0);
        if (custodyOpen) return controller;
        address holder = ICitizenNft(nftContract).ownerOf(tokenId);
        if (holder == address(this)) return address(0);
        return holder;
    }

    function sessionEpoch() external view returns (uint256) {
        return session.epoch;
    }

    function sessionDead() external view returns (bool) {
        return session.dead;
    }

    function sessionNonce() external view returns (uint256) {
        return session.nonce;
    }

    function sessionValueSpent() external view returns (uint256) {
        return session.spent;
    }

    function sessionTokenSpent() external view returns (uint256) {
        return session.tokenSpent;
    }

    function deposit() external ready nonReentrant {
        if (custodyOpen) revert AlreadyInCustody();
        address holder = ICitizenNft(nftContract).ownerOf(tokenId);
        if (holder == address(this)) revert UntrackedCustody();
        if (msg.sender != holder) revert NotNftOwner();
        _bumpEpoch();
        controller = msg.sender;
        expectingReceive = true;
        ICitizenNft(nftContract).safeTransferFrom(msg.sender, address(this), tokenId);
        expectingReceive = false;
        if (ICitizenNft(nftContract).ownerOf(tokenId) != address(this)) revert CustodyChanged();
        custodyOpen = true;
        emit Deposited(msg.sender, authEpoch);
    }

    function release(address to) external ready nonReentrant {
        _requireController();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        _bumpEpoch();
        address previous = controller;
        controller = address(0);
        custodyOpen = false;
        ICitizenNft(nftContract).safeTransferFrom(address(this), to, tokenId);
        if (ICitizenNft(nftContract).ownerOf(tokenId) == address(this)) revert StillHeld();
        emit Released(previous, to, authEpoch);
    }

    /// @notice Human path. Live owner, or the controller while in custody.
    /// Increments authEpoch before the call, so it retires any AI session.
    /// It is not subject to the AI budget. It cannot move the custodied NFT.
    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        ready
        nonReentrant
        returns (bytes memory)
    {
        _requireAuthority();
        _bumpEpoch();
        _requireAllowedTarget(target);
        bytes4 selector = _selector(data);
        _rejectApproval(selector);
        bytes memory result = _call(target, value, data);
        if (custodyOpen && ICitizenNft(nftContract).ownerOf(tokenId) != address(this)) revert CustodyChanged();
        executionCount += 1;
        emit Executed(msg.sender, target, value, selector);
        return result;
    }

    function openSession(SessionParams calldata params) external ready nonReentrant returns (uint256 epoch) {
        _requireController();
        _validateSession(params);
        _bumpEpoch();
        epoch = authEpoch;
        Session storage opened = session;
        opened.executor = params.executor;
        opened.controllerAtOpen = msg.sender;
        opened.target = params.target;
        opened.selector = params.selector;
        opened.maxValuePerCall = params.maxValuePerCall;
        opened.maxCumulativeValue = params.maxCumulativeValue;
        opened.spent = 0;
        opened.spendToken = params.spendToken;
        opened.maxTokenPerCall = params.maxTokenPerCall;
        opened.maxTokenCumulative = params.maxTokenCumulative;
        opened.tokenSpent = 0;
        opened.expiresAt = uint64(block.timestamp + params.ttlSeconds);
        opened.openedBlock = uint64(block.number);
        opened.nonce = 0;
        opened.epoch = epoch;
        opened.dead = false;
        opened.paused = false;
        emit SessionOpened(msg.sender, opened.executor, opened.target, opened.selector, opened.expiresAt, epoch);
    }

    function pauseSession(bool paused) external ready nonReentrant {
        _requireController();
        if (session.executor == address(0) || session.dead) revert SessionInactive();
        if (session.epoch != authEpoch) revert StaleEpoch();
        session.paused = paused;
    }

    function revokeSession() external ready nonReentrant {
        _requireController();
        if (session.executor == address(0) || session.dead) revert SessionInactive();
        _bumpEpoch();
    }

    function executeSession(uint256 expectedNonce, address target, uint256 value, bytes calldata data)
        external
        payable
        ready
        nonReentrant
        returns (bytes memory)
    {
        bytes4 selector = _authorizeSession(expectedNonce, target, value, data);
        uint256 ethBefore = address(this).balance;
        uint256 tokenBefore = _sessionTokenBefore();
        bytes memory result = _call(target, value, data);
        _finishSession(selector, value, ethBefore, tokenBefore, data);
        return result;
    }

    /// @notice Accept the NFT only while deposit() is pulling it.
    /// To pause autonomy, call pauseSession or revokeSession. To transfer the
    /// NFT, the controller calls release(to) first. That retires the session.
    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        if (address(this) == self) revert DirectCall();
        if (!initialized || block.chainid != boundChainId) revert WrongChain();
        if (msg.sender != nftContract || id != tokenId || !expectingReceive) revert UnexpectedNft();
        return CitizenAccountV2.onERC721Received.selector;
    }

    function _authorizeSession(uint256 expectedNonce, address target, uint256 value, bytes calldata data)
        internal
        returns (bytes4 selector)
    {
        _requireLiveCustody();
        Session storage item = session;
        if (item.executor == address(0)) revert SessionInactive();
        if (item.epoch != authEpoch) revert StaleEpoch();
        if (item.dead) revert SessionDead();
        if (item.paused) revert SessionPaused();
        if (item.executor != msg.sender) revert NotAuthorized();
        if (block.timestamp >= item.expiresAt) revert SessionExpired();
        if (item.nonce != expectedNonce) revert Replay();
        if (target != item.target) revert TargetNotAllowed();
        selector = _selector(data);
        _checkSessionCall(item, target, selector, value, data);
        item.nonce = expectedNonce + 1;
        item.spent = item.spent + value;
    }

    function _checkSessionCall(
        Session storage item,
        address target,
        bytes4 selector,
        uint256 value,
        bytes calldata data
    ) internal view {
        _requireAllowedTarget(target);
        if (selector != item.selector) revert SelectorNotAllowed();
        _rejectApproval(selector);
        if (value > item.maxValuePerCall) revert ValueNotAllowed();
        if (item.spent + value > item.maxCumulativeValue) revert SpendLimit();
        (uint256 declared, bool tracked) = _trackedTokenAmount(selector, data);
        if (!tracked) return;
        if (item.spendToken == address(0) || target != item.spendToken) revert TokenNotAllowed();
        if (declared > item.maxTokenPerCall || item.tokenSpent + declared > item.maxTokenCumulative) revert TokenSpendLimit();
    }

    function _finishSession(
        bytes4 selector,
        uint256 value,
        uint256 ethBefore,
        uint256 tokenBefore,
        bytes calldata data
    ) internal {
        (uint256 declared, bool tracked) = _trackedTokenAmount(selector, data);
        _settleTokenSpend(declared, tracked, tokenBefore);
        uint256 ethAfter = address(this).balance;
        if (ethAfter < ethBefore && ethBefore - ethAfter > value) revert ValueNotAllowed();
        _requireLiveCustody();
        if (session.epoch != authEpoch) revert CustodyChanged();
        executionCount += 1;
        emit Executed(msg.sender, session.target, value, selector);
    }

    function _requireLiveCustody() internal view {
        if (!custodyOpen || ICitizenNft(nftContract).ownerOf(tokenId) != address(this)) revert NotInCustody();
    }

    function _sessionTokenBefore() internal view returns (uint256) {
        address spendToken = session.spendToken;
        if (spendToken == address(0)) return 0;
        return _tokenBalance(spendToken);
    }

    function _requireAuthority() internal view {
        if (!custodyOpen && ICitizenNft(nftContract).ownerOf(tokenId) == address(this)) revert UntrackedCustody();
        address who = custodyOpen ? controller : ICitizenNft(nftContract).ownerOf(tokenId);
        if (who == address(0) || msg.sender != who) revert NotAuthorized();
    }

    function _requireController() internal view {
        if (!custodyOpen || ICitizenNft(nftContract).ownerOf(tokenId) != address(this)) revert NotInCustody();
        if (msg.sender != controller) revert NotAuthorized();
    }

    function _bumpEpoch() internal {
        authEpoch += 1;
        if (session.executor != address(0) && !session.dead) {
            session.dead = true;
            emit SessionInvalidated(msg.sender, authEpoch);
        }
    }

    function _validateSession(SessionParams calldata params) internal view {
        if (params.executor == address(0) || params.executor == address(this)) revert ZeroAddress();
        if (params.ttlSeconds == 0 || params.ttlSeconds > 30 days) revert InvalidTtl();
        if (params.maxCumulativeValue < params.maxValuePerCall) revert InvalidLimit();
        if (params.maxTokenCumulative < params.maxTokenPerCall) revert InvalidLimit();
        _requireAllowedTarget(params.target);
        _rejectApproval(params.selector);
        if (_isTrackedTokenSelector(params.selector)) {
            if (params.spendToken == address(0) || params.target != params.spendToken) revert TokenNotAllowed();
        }
    }

    function _requireAllowedTarget(address target) internal view {
        if (target == address(0) || target == address(this) || target == nftContract || target == implementation()) {
            revert TargetNotAllowed();
        }
    }

    function _rejectApproval(bytes4 selector) internal pure {
        if (
            selector == APPROVE || selector == INCREASE_ALLOWANCE || selector == INCREASE_APPROVAL
                || selector == SET_APPROVAL_FOR_ALL || selector == PERMIT || selector == DAI_PERMIT
        ) {
            revert ApprovalDisabled();
        }
    }

    function _selector(bytes calldata data) internal pure returns (bytes4 selector) {
        if (data.length < 4) revert SelectorNotAllowed();
        selector = bytes4(data[0:4]);
    }

    function _isTrackedTokenSelector(bytes4 selector) internal pure returns (bool) {
        return selector == ERC20_TRANSFER || selector == ERC20_TRANSFER_FROM;
    }

    function _trackedTokenAmount(bytes4 selector, bytes calldata data) internal pure returns (uint256 amount, bool tracked) {
        if (selector == ERC20_TRANSFER) {
            if (data.length < 68) revert SelectorNotAllowed();
            (, amount) = abi.decode(data[4:], (address, uint256));
            tracked = true;
        } else if (selector == ERC20_TRANSFER_FROM) {
            if (data.length < 100) revert SelectorNotAllowed();
            (,, amount) = abi.decode(data[4:], (address, address, uint256));
            tracked = true;
        }
    }

    function _tokenBalance(address spendToken) internal view returns (uint256) {
        return ISpendToken(spendToken).balanceOf(address(this));
    }

    function _settleTokenSpend(uint256 declared, bool tracked, uint256 tokenBefore) internal {
        address spendToken = session.spendToken;
        if (spendToken == address(0)) return;
        uint256 tokenAfter = _tokenBalance(spendToken);
        uint256 delta = tokenBefore > tokenAfter ? tokenBefore - tokenAfter : 0;
        uint256 accounted = tracked ? declared : 0;
        uint256 spentNow = delta > accounted ? delta : accounted;
        if (spentNow == 0) return;
        if (spentNow > session.maxTokenPerCall || session.tokenSpent + spentNow > session.maxTokenCumulative) {
            revert TokenSpendLimit();
        }
        session.tokenSpent += spentNow;
    }

    function _call(address target, uint256 value, bytes calldata data) internal returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
