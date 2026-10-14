// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title EventAnchor
/// @notice Append-only commitments of Merkle roots for chogOS event batches.
/// A stored root commits to the submitted data. It does not prove the
/// simulation was truthful, and it does not move funds.
///
/// Offchain leaves are OpenZeppelin StandardMerkleTree(["bytes32"], sortLeaves: false).
/// A future on-chain inclusion check must use the same leaf:
///   bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(eventHash))));
/// and OpenZeppelin MerkleProof.verify (commutative pair hashing). This contract
/// only stores roots; it does not verify inclusion proofs.
contract EventAnchor {
    error NotOwner();
    error ZeroRoot();
    error InvalidRange();
    error DuplicateBatch();
    error DuplicateRoot();
    error ZeroAddress();

    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 merkleRoot,
        uint64 fromSeq,
        uint64 toSeq,
        uint32 eventCount,
        bytes32 treeFormat
    );
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    struct Batch {
        bytes32 merkleRoot;
        uint64 fromSeq;
        uint64 toSeq;
        uint32 eventCount;
        bytes32 treeFormat;
        uint64 anchoredAt;
    }

    address public owner;
    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => bytes32) public batchIdByRoot;
    bytes32[] public batchIds;

    bytes32 public constant TREE_FORMAT = keccak256("openzeppelin-standard-v1");

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnerTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function submitBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        uint64 fromSeq,
        uint64 toSeq,
        uint32 eventCount
    ) external onlyOwner {
        if (merkleRoot == bytes32(0) || batchId == bytes32(0)) revert ZeroRoot();
        if (eventCount == 0 || toSeq < fromSeq) revert InvalidRange();
        if (batches[batchId].anchoredAt != 0) revert DuplicateBatch();
        if (batchIdByRoot[merkleRoot] != bytes32(0)) revert DuplicateRoot();

        batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            fromSeq: fromSeq,
            toSeq: toSeq,
            eventCount: eventCount,
            treeFormat: TREE_FORMAT,
            anchoredAt: uint64(block.timestamp)
        });
        batchIdByRoot[merkleRoot] = batchId;
        batchIds.push(batchId);
        emit BatchAnchored(batchId, merkleRoot, fromSeq, toSeq, eventCount, TREE_FORMAT);
    }

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    function batchCount() external view returns (uint256) {
        return batchIds.length;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
