// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CitizenAccount} from "../src/CitizenAccount.sol";
import {CitizenAccountFactory} from "../src/CitizenAccountFactory.sol";
import {MockGenesisNFT, MockSink} from "./MockGenesisNFT.sol";

contract CitizenAccountTest is Test {
    CitizenAccountFactory internal factory;
    MockGenesisNFT internal nft;
    MockSink internal sink;
    MockSink internal otherSink;
    CitizenAccount internal account;

    address internal walletA = address(0xA11CE);
    address internal walletB = address(0xB0B);
    address internal walletC = address(0xC0);
    address internal executor = address(0xE1);
    uint256 internal tokenId = 7;
    bytes4 internal pingSelector = MockSink.ping.selector;

    function setUp() public {
        factory = new CitizenAccountFactory();
        nft = new MockGenesisNFT();
        sink = new MockSink();
        otherSink = new MockSink();
        nft.mint(walletA, tokenId);
        nft.mint(walletA, 8);
        account = CitizenAccount(payable(factory.create(block.chainid, address(nft), tokenId)));
    }

    function testPredictMatchesCreateAndIsIdempotent() public {
        address predicted = factory.predict(block.chainid, address(nft), tokenId);
        assertEq(predicted, address(account));
        address second = factory.create(block.chainid, address(nft), tokenId);
        assertEq(second, address(account));
        address other = factory.create(block.chainid, address(nft), 8);
        assertTrue(other != address(account));
        assertEq(other, factory.predict(block.chainid, address(nft), 8));
    }

    function testOwnerCanExecuteAndPreviousOwnerCannotAfterTransfer() public {
        vm.deal(address(account), 1 ether);
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 11));
        assertEq(sink.lastValue(), 11);
        assertEq(sink.lastCaller(), address(account));

        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        assertEq(account.currentOwner(), walletB);

        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 12));

        vm.prank(walletB);
        account.execute(address(sink), 0.1 ether, abi.encodeWithSelector(pingSelector, 13));
        assertEq(sink.lastValue(), 13);
        assertEq(address(sink).balance, 0.1 ether);
    }

    function testSecondTransferMovesAuthorityAgain() public {
        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.prank(walletB);
        nft.transfer(walletC, tokenId);
        assertEq(account.currentOwner(), walletC);
        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(walletB);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
        vm.prank(walletC);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 2));
        assertEq(sink.lastValue(), 2);
    }

    function testDelegationPolicyAndReplay() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = account.grantDelegation(executor, address(sink), pingSelector, false, expiry);

        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 42));
        assertEq(sink.lastValue(), 42);

        vm.expectRevert(CitizenAccount.Replay.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 43));

        vm.prank(executor);
        account.executeDelegated(id, 1, address(sink), 0, abi.encodeWithSelector(pingSelector, 43));
        assertEq(sink.lastValue(), 43);
    }

    function testRejectsUnauthorizedTargetSelectorValueAndWrongExecutor() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = account.grantDelegation(executor, address(sink), pingSelector, false, expiry);

        vm.expectRevert(CitizenAccount.TargetNotAllowed.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(otherSink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.expectRevert(CitizenAccount.SelectorNotAllowed.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(MockSink.fail.selector));

        vm.expectRevert(CitizenAccount.ValueNotAllowed.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 1, abi.encodeWithSelector(pingSelector, 1));

        vm.expectRevert(CitizenAccount.DelegationInvalid.selector);
        vm.prank(walletB);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
    }

    function testRevocationAndExpiry() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = account.grantDelegation(executor, address(sink), pingSelector, true, expiry);

        vm.prank(walletA);
        account.revokeDelegation(id);
        vm.expectRevert(CitizenAccount.DelegationInvalid.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.prank(walletA);
        uint256 fresh = account.grantDelegation(executor, address(sink), pingSelector, false, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        vm.expectRevert(CitizenAccount.Expired.selector);
        vm.prank(executor);
        account.executeDelegated(fresh, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
    }

    function testDelegationDiesOnNftTransfer() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = account.grantDelegation(executor, address(sink), pingSelector, false, expiry);
        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(executor);
        account.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(walletA);
        account.revokeDelegation(id);
        vm.prank(walletB);
        account.revokeDelegation(id);
    }

    function testWrongChainAndFailedCall() public {
        uint256 home = block.chainid;
        vm.chainId(999);
        vm.expectRevert(CitizenAccount.WrongChain.selector);
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.chainId(home);
        vm.expectRevert("sink-failed");
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.fail.selector));
    }

    function testConstructorAndGrantGuards() public {
        vm.expectRevert(CitizenAccount.ZeroChain.selector);
        new CitizenAccount(0, address(nft), tokenId);
        vm.expectRevert(CitizenAccount.ZeroAddress.selector);
        new CitizenAccount(1, address(0), tokenId);
        vm.expectRevert(CitizenAccountFactory.ZeroChain.selector);
        factory.create(0, address(nft), 9);
        vm.expectRevert(CitizenAccountFactory.ZeroAddress.selector);
        factory.create(block.chainid, address(0), 9);

        vm.expectRevert(CitizenAccount.Expired.selector);
        vm.prank(walletA);
        account.grantDelegation(executor, address(sink), pingSelector, false, uint64(block.timestamp));
        vm.expectRevert(CitizenAccount.SelectorNotAllowed.selector);
        vm.prank(walletA);
        account.grantDelegation(executor, address(sink), bytes4(0), false, uint64(block.timestamp + 10));
        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(executor);
        account.grantDelegation(executor, address(sink), pingSelector, false, uint64(block.timestamp + 10));
    }

    function testIdentityIsStableAcrossTransfers() public {
        (uint256 chainId_, address nft_, uint256 id_) = account.token();
        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        (uint256 chainId2, address nft2, uint256 id2) = account.token();
        assertEq(chainId_, chainId2);
        assertEq(nft_, nft2);
        assertEq(id_, id2);
        assertEq(address(account), factory.predict(block.chainid, address(nft), tokenId));
    }
}
