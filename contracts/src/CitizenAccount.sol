// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenAccount
/// @notice NFT-bound account for one (chain, NFT contract, token id).
/// Root authority is ownerOf at call time. V1 grantDelegation remains disabled
/// because ownerAtGrant revives after A→B→A.
///
/// V1.1 executor sessions: the NFT owner may open one restricted session.
/// syncOwner() latches the session dead when a different owner is observed.
/// A→B→A with no sync while B holds still cannot be seen on-chain (Genesis has
/// no transfer callback). The relayer must call invalidateSession after any
/// Transfer log. The AI model never holds a key.
interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract CitizenAccount {
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error NotNftOwner();
    error NotAuthorized();
    error SelectorNotAllowed();
    error Reentrant();
    error DelegationDisabled();
    error SessionDead();
    error SessionPaused();
    error SessionExpired();
    error SessionInactive();
    error Replay();
    error TargetNotAllowed();
    error ValueNotAllowed();
    error SpendLimit();
    error InvalidTtl();

    event Executed(address indexed caller, address indexed target, uint256 value, bytes4 selector);
    event SessionOpened(address indexed owner, address indexed executor, address target, bytes4 selector, uint64 expiresAt);
    event SessionInvalidated(address indexed caller, uint256 epoch);
    event OwnerSynced(address indexed previousOwner, address indexed currentOwner, uint256 epoch);

    struct Session {
        address executor;
        address ownerAtOpen;
        address target;
        bytes4 selector;
        uint256 maxValuePerCall;
        uint256 maxCumulativeValue;
        uint256 spent;
        uint64 expiresAt;
        uint64 openedBlock;
        uint256 nonce;
        bool dead;
        bool paused;
    }

    uint256 public immutable boundChainId;
    address public immutable nftContract;
    uint256 public immutable tokenId;

    uint256 public ownerNonce;
    uint256 public ownerEpoch;
    address public lastSeenOwner;
    Session public session;
    uint256 private locked;

    constructor(uint256 chainId_, address nftContract_, uint256 tokenId_) {
        if (chainId_ == 0) revert ZeroChain();
        if (chainId_ != block.chainid) revert WrongChain();
        if (nftContract_ == address(0)) revert ZeroAddress();
        boundChainId = chainId_;
        nftContract = nftContract_;
        tokenId = tokenId_;
        lastSeenOwner = IERC721OwnerOf(nftContract_).ownerOf(tokenId_);
    }

    receive() external payable {}

    function currentOwner() public view returns (address) {
        return IERC721OwnerOf(nftContract).ownerOf(tokenId);
    }

    function token() external view returns (uint256, address, uint256) {
        return (boundChainId, nftContract, tokenId);
    }

    function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        syncOwner();
        _requireNftOwner();
        ownerNonce += 1;
        bytes memory result = _call(target, value, data);
        emit Executed(msg.sender, target, value, _selector(data));
        return result;
    }

    /// @dev V1 grants stay disabled. Use openSession instead.
    function grantDelegation(address, address, bytes4, bool, uint64) external pure returns (uint256) {
        revert DelegationDisabled();
    }

    function revokeDelegation(uint256) external pure {
        revert DelegationDisabled();
    }

    function executeDelegated(uint256, uint256, address, uint256, bytes calldata)
        external
        payable
        returns (bytes memory)
    {
        revert DelegationDisabled();
    }

    function syncOwner() public {
        address owner = currentOwner();
        address previous = lastSeenOwner;
        if (owner == previous) {
            return;
        }
        lastSeenOwner = owner;
        ownerEpoch += 1;
        if (session.executor != address(0) && !session.dead) {
            session.dead = true;
            emit SessionInvalidated(msg.sender, ownerEpoch);
        }
        emit OwnerSynced(previous, owner, ownerEpoch);
    }

    function openSession(
        address executor,
        address target,
        bytes4 selector,
        uint256 maxValuePerCall,
        uint256 maxCumulativeValue,
        uint64 ttlSeconds
    ) external returns (uint256 epoch) {
        syncOwner();
        _requireNftOwner();
        if (executor == address(0) || target == address(0)) revert ZeroAddress();
        if (ttlSeconds == 0 || ttlSeconds > 30 days) revert InvalidTtl();
        epoch = ownerEpoch;
        session = Session({
            executor: executor,
            ownerAtOpen: msg.sender,
            target: target,
            selector: selector,
            maxValuePerCall: maxValuePerCall,
            maxCumulativeValue: maxCumulativeValue,
            spent: 0,
            expiresAt: uint64(block.timestamp + ttlSeconds),
            openedBlock: uint64(block.number),
            nonce: 0,
            dead: false,
            paused: false
        });
        emit SessionOpened(msg.sender, executor, target, selector, session.expiresAt);
    }

    function pauseSession(bool paused) external {
        syncOwner();
        _requireNftOwner();
        if (session.executor == address(0)) revert SessionInactive();
        session.paused = paused;
    }

    function revokeSession() external {
        syncOwner();
        _requireNftOwner();
        if (session.executor == address(0)) revert SessionInactive();
        session.dead = true;
        emit SessionInvalidated(msg.sender, ownerEpoch);
    }

    /// @dev Executor or current owner. Relayer must call this if Transfer logs
    /// exist after openedBlock even when ownerOf currently matches ownerAtOpen.
    function invalidateSession() external {
        syncOwner();
        if (msg.sender != session.executor && msg.sender != currentOwner()) revert NotAuthorized();
        if (session.executor == address(0)) revert SessionInactive();
        session.dead = true;
        emit SessionInvalidated(msg.sender, ownerEpoch);
    }

    function executeSession(uint256 expectedNonce, address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory)
    {
        syncOwner();
        Session memory item = session;
        if (item.executor == address(0)) revert SessionInactive();
        if (item.dead) revert SessionDead();
        if (item.paused) revert SessionPaused();
        if (item.executor != msg.sender) revert NotAuthorized();
        if (block.timestamp >= item.expiresAt) revert SessionExpired();
        if (currentOwner() != item.ownerAtOpen) revert NotNftOwner();
        if (item.nonce != expectedNonce) revert Replay();
        if (target != item.target) revert TargetNotAllowed();
        bytes4 selector = _selector(data);
        if (selector != item.selector) revert SelectorNotAllowed();
        if (value > item.maxValuePerCall) revert ValueNotAllowed();
        uint256 nextSpent = item.spent + value;
        if (nextSpent > item.maxCumulativeValue) revert SpendLimit();
        session.nonce = item.nonce + 1;
        session.spent = nextSpent;
        bytes memory result = _call(target, value, data);
        emit Executed(msg.sender, target, value, selector);
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
