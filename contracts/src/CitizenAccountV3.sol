// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CitizenAccountV3
/// @notice Permanent citizen wallet. The proxy address is the wallet.
/// Identity is (chain id, Genesis NFT, token id). The NFT holder is not an owner.
/// The wallet does not take custody of the NFT and does not read ownerOf.
/// One immutable agent key authorizes calls. It cannot upgrade the wallet or
/// replace itself. A signature authorizes one exact call. It is not a treasury
/// allocation, and a treasury allocation is not a wallet call.
/// Deployed as the implementation behind wallets created by CitizenAccountFactoryV3
/// at 0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A. The proxy is the citizen wallet.
contract CitizenAccountV3 {
    error DirectCall();
    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroChain();
    error WrongChain();
    error BadAction();
    error Expired();
    error DeadlineTooFar();
    error Replay();
    error BadSigner();
    error TargetNotAllowed();
    error BadCalldata();
    error CallFailed();
    error Reentrant();
    error UnexpectedNft();

    event Executed(bytes32 indexed actionId, address indexed target, uint256 value, bytes32 dataHash);

    uint256 internal constant UNLOCKED = 1;
    uint256 internal constant LOCKED = 2;
    uint256 internal constant MAX_TTL = 1 days;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("chogOS CitizenWallet");
    bytes32 private constant VERSION_HASH = keccak256("3");
    bytes32 private constant ACTION_TYPEHASH = keccak256(
        "Action(bytes32 actionId,uint256 tokenId,address target,uint256 value,bytes32 dataHash,uint256 deadline)"
    );
    bytes32 private constant SECP256K1_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address private immutable self;
    address public immutable agent;

    uint256 private lock;
    bool public initialized;
    uint256 public boundChainId;
    address public nftContract;
    uint256 public tokenId;
    mapping(bytes32 => bool) public usedAction;

    constructor(address agent_) {
        if (agent_ == address(0)) revert ZeroAddress();
        self = address(this);
        agent = agent_;
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
        return 3;
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

    receive() external payable {}

    /// @notice Reject safe NFT delivery. This wallet is not an NFT custodian.
    /// A raw transferFrom can still change ownerOf because Genesis does not
    /// call the recipient. That does not change who can operate this wallet.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnexpectedNft();
    }

    function actionDigest(bytes32 actionId, address target, uint256 value, bytes32 dataHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, boundChainId, address(this)));
        bytes32 structHash = keccak256(abi.encode(ACTION_TYPEHASH, actionId, tokenId, target, value, dataHash, deadline));
        return keccak256(abi.encodePacked(bytes2(0x1901), domain, structHash));
    }

    /// @notice One signed call. The agent key is the only signer. There is no
    /// public execute and no NFT-holder path. Standard approvals are allowed
    /// only when this exact calldata was signed. The wallet never delegatecalls.
    function execute(bytes32 actionId, address target, uint256 value, bytes calldata data, uint256 deadline, bytes calldata signature)
        external
        payable
        ready
        nonReentrant
        returns (bytes memory)
    {
        if (actionId == bytes32(0) || usedAction[actionId]) revert Replay();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_TTL) revert DeadlineTooFar();
        if (data.length != 0 && data.length < 4) revert BadCalldata();
        _requireTarget(target);
        _requireAgent(actionDigest(actionId, target, value, keccak256(data), deadline), signature);
        usedAction[actionId] = true;
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(actionId, target, value, keccak256(data));
        return result;
    }

    function _requireTarget(address target) private view {
        if (target == address(0) || target == address(this) || target == self || target == nftContract) {
            revert TargetNotAllowed();
        }
    }

    function _requireAgent(bytes32 digest, bytes calldata signature) private view {
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
        if (signer == address(0) || signer != agent) revert BadSigner();
    }
}
