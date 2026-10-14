// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EventAnchor} from "../src/EventAnchor.sol";

contract EventAnchorTest is Test {
    EventAnchor internal anchor;
    address internal owner = address(0xA11CE);
    address internal other = address(0xB0B);

    bytes32 internal constant BATCH = keccak256("batch-1");
    bytes32 internal constant ROOT = keccak256("root-1");
    bytes32 internal constant ROOT_2 = keccak256("root-2");

    function setUp() public {
        anchor = new EventAnchor(owner);
    }

    function testOwnerCanSubmitAndQuery() public {
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 10);
        EventAnchor.Batch memory stored = anchor.getBatch(BATCH);
        assertEq(stored.merkleRoot, ROOT);
        assertEq(stored.fromSeq, 1);
        assertEq(stored.toSeq, 10);
        assertEq(stored.eventCount, 10);
        assertTrue(stored.anchoredAt != 0);
        assertEq(anchor.batchCount(), 1);
        assertEq(anchor.batchIdByRoot(ROOT), BATCH);
        assertEq(stored.treeFormat, keccak256("openzeppelin-standard-v1"));
    }

    function testRejectsNonOwner() public {
        vm.expectRevert(EventAnchor.NotOwner.selector);
        vm.prank(other);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 10);
    }

    function testRejectsDuplicateBatchAndRoot() public {
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 10);
        vm.expectRevert(EventAnchor.DuplicateBatch.selector);
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT_2, 11, 20, 10);
        vm.expectRevert(EventAnchor.DuplicateRoot.selector);
        vm.prank(owner);
        anchor.submitBatch(keccak256("batch-2"), ROOT, 11, 20, 10);
    }

    function testRejectsZeroRootAndBadRange() public {
        vm.expectRevert(EventAnchor.ZeroRoot.selector);
        vm.prank(owner);
        anchor.submitBatch(BATCH, bytes32(0), 1, 10, 10);
        vm.expectRevert(EventAnchor.InvalidRange.selector);
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT, 10, 1, 10);
        vm.expectRevert(EventAnchor.InvalidRange.selector);
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 0);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(EventAnchor.ZeroAddress.selector);
        new EventAnchor(address(0));
    }

    function testTransferOwnership() public {
        vm.prank(owner);
        anchor.transferOwnership(other);
        assertEq(anchor.owner(), other);
        vm.expectRevert(EventAnchor.NotOwner.selector);
        vm.prank(owner);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 10);
        vm.prank(other);
        anchor.submitBatch(BATCH, ROOT, 1, 10, 10);
        assertEq(anchor.getBatch(BATCH).merkleRoot, ROOT);
    }
}
