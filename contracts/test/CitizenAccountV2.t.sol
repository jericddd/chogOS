// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {CitizenAccountV2} from "../src/CitizenAccountV2.sol";
import {CitizenAccountFactoryV2} from "../src/CitizenAccountFactoryV2.sol";
import {CitizenWalletProxy} from "../src/CitizenWalletProxy.sol";
import {DeployCitizenAccountFactoryV2} from "../script/DeployCitizenAccountFactoryV2.s.sol";
import {DeployCitizenAccountFactory} from "../script/DeployCitizenAccountFactory.s.sol";
import {MockGenesisNFT, MockSink} from "./MockGenesisNFT.sol";

/// @dev Code the current owner must not be able to install. It ignores NFT ownership.
contract HostileWallet {
    address public immutable thief;

    constructor(address thief_) {
        thief = thief_;
    }

    function codeVersion() external pure returns (uint256) {
        return 1;
    }

    /// @dev Present so a factory that only checks codeVersion can finish CREATE2.
    /// That check is not proof the implementation is safe.
    function initialize(uint256, address, uint256) external {}

    function drain() external {
        (bool ok,) = thief.call{value: address(this).balance}("");
        require(ok, "drain");
    }

    function execute(address, uint256, bytes calldata) external {
        (bool ok,) = thief.call{value: address(this).balance}("");
        require(ok, "seize");
    }
}

contract GreedyToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    /// @dev Moves tokens from `from` without an allowance. A session target can call this.
    function grab(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[msg.sender] += amount;
    }
}

contract TokenGrabber {
    function grab(address token, address from, uint256 amount) external {
        GreedyToken(token).grab(from, amount);
    }
}

contract ReenterRelease {
    function ping(address wallet, address to) external {
        (bool ok,) = wallet.call(abi.encodeWithSignature("release(address)", to));
        require(!ok, "reenter released");
    }
}

contract ReenterExecute {
    function ping(address wallet, address sink) external {
        CitizenAccountV2(payable(wallet)).execute(sink, 1 ether, abi.encodeWithSignature("ping(uint256)", 1));
    }
}

contract NftBounce {
    MockGenesisNFT internal nft;
    uint256 internal tokenId;
    address internal wallet;

    constructor(MockGenesisNFT nft_, uint256 tokenId_, address wallet_) {
        nft = nft_;
        tokenId = tokenId_;
        wallet = wallet_;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        nft.transferFrom(address(this), wallet, tokenId);
        return this.onERC721Received.selector;
    }
}

/// @notice The authorization path is the wallet. These tests do not call a watcher,
/// an RPC client, or an ownership cache.
contract CitizenAccountV2Test is Test {
    address internal constant GENESIS = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    bytes32 internal constant EXECUTED = keccak256("Executed(address,address,uint256,bytes4)");

    CitizenAccountV2 internal implementation;
    CitizenAccountFactoryV2 internal factory;
    MockGenesisNFT internal nft;
    MockSink internal sink;
    GreedyToken internal token;
    CitizenAccountV2 internal wallet104;
    CitizenAccountV2 internal wallet129;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal executor = makeAddr("executor");
    address internal executorB = makeAddr("executor-b");

    function setUp() public {
        implementation = new CitizenAccountV2();
        factory = new CitizenAccountFactoryV2(address(implementation));
        nft = new MockGenesisNFT();
        sink = new MockSink();
        token = new GreedyToken();
        nft.mint(alice, 104);
        nft.mint(alice, 129);
        wallet104 = CitizenAccountV2(payable(factory.create(block.chainid, address(nft), 104)));
        wallet129 = CitizenAccountV2(payable(factory.create(block.chainid, address(nft), 129)));
        vm.deal(address(wallet104), 1 ether);
        vm.deal(address(wallet129), 1 ether);
        token.mint(address(wallet104), 1_000);
    }

    function testPermanentIdentitySurvivesHumanTransfers() public {
        address first = address(wallet104);
        _assertIdentity(wallet104, 104, 1 ether, 0);

        vm.prank(alice);
        nft.transfer(bob, 104);
        vm.prank(bob);
        nft.transfer(carol, 104);
        vm.prank(carol);
        nft.transfer(alice, 104);

        assertEq(address(wallet104), first);
        assertEq(nft.ownerOf(104), alice);
        _assertIdentity(wallet104, 104, 1 ether, 0);
        assertEq(wallet104.authority(), alice);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(carol.balance, 0);

        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(bob);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));

        vm.prank(alice);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 7));
        assertEq(sink.lastValue(), 7);
        assertEq(address(wallet104).balance, 1 ether);
        assertEq(wallet104.executionCount(), 1);
    }

    function testAliceToBobMovesAuthorityAndLeavesAssets() public {
        vm.prank(alice);
        nft.transfer(bob, 104);

        assertEq(wallet104.authority(), bob);
        assertEq(address(wallet104).balance, 1 ether);
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(alice);
        wallet104.execute(address(sink), 0.2 ether, abi.encodeWithSelector(sink.ping.selector, 1));

        vm.prank(bob);
        wallet104.execute(address(sink), 0.2 ether, abi.encodeWithSelector(sink.ping.selector, 2));
        assertEq(address(sink).balance, 0.2 ether);
        assertEq(address(wallet104).balance, 0.8 ether);
        assertEq(bob.balance, 0);
        _assertIdentity(wallet104, 104, 0.8 ether, 1);
    }

    function testMultipleOwnersDoNotMoveTheWallet() public {
        vm.prank(alice);
        nft.transfer(bob, 104);
        vm.prank(bob);
        wallet104.execute(address(sink), 0.1 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        uint256 executions = wallet104.executionCount();
        uint256 balance = address(wallet104).balance;

        vm.prank(bob);
        nft.transfer(carol, 104);
        vm.prank(carol);
        nft.transfer(bob, 104);
        vm.prank(bob);
        nft.transfer(alice, 104);

        assertEq(wallet104.authority(), alice);
        assertEq(wallet104.executionCount(), executions);
        assertEq(address(wallet104).balance, balance);
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(carol);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 2));
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(bob);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 2));
    }

    function testEscrowReleaseDoesNotTransferAssets() public {
        _deposit(wallet104, alice, 104);
        assertEq(nft.ownerOf(104), address(wallet104));
        assertEq(wallet104.custodyOpen(), true);
        assertEq(wallet104.authority(), alice);

        _open(wallet104, alice, executor, 0.05 ether, 0.05 ether);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0.05 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        uint256 balance = address(wallet104).balance;
        uint256 executions = wallet104.executionCount();

        _release(wallet104, alice, bob);
        assertEq(nft.ownerOf(104), bob);
        assertEq(wallet104.custodyOpen(), false);
        assertEq(wallet104.controller(), address(0));
        assertEq(wallet104.authority(), bob);
        assertEq(address(wallet104).balance, balance);
        assertEq(bob.balance, 0);
        assertEq(wallet104.executionCount(), executions);
        assertTrue(wallet104.sessionDead());
        assertTrue(wallet104.sessionEpoch() != wallet104.authEpoch());

        vm.prank(bob);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 4));
        assertEq(sink.lastValue(), 4);
        assertEq(address(wallet104).balance, balance);
        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 5));
    }

    function testOldSessionFailsAfterTransfer() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));

        _release(wallet104, alice, bob);
        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 2));

        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(executor);
        wallet104.execute(address(sink), 1 ether, abi.encodeWithSelector(sink.ping.selector, 3));
        assertEq(sink.lastValue(), 1);
    }

    function testNftCannotLeaveCustodyWithoutTheWallet() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);

        vm.expectRevert(MockGenesisNFT.NotOwner.selector);
        vm.prank(alice);
        nft.transfer(bob, 104);
        vm.expectRevert(MockGenesisNFT.NotApproved.selector);
        vm.prank(bob);
        nft.transferFrom(address(wallet104), bob, 104);
        vm.expectRevert(CitizenAccountV2.TargetNotAllowed.selector);
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(nft), nft.transferFrom.selector, 0, 0, address(0), 0, 0));

        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 4));
        assertEq(nft.ownerOf(104), address(wallet104));
        assertEq(wallet104.sessionDead(), false);
        assertEq(sink.lastValue(), 4);
    }

    /// @dev No invalidate, no watcher, and no second observation of the NFT.
    /// The later human transfers never call the wallet. The session still cannot spend.
    function testMissedObservationCannotReviveSession() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0.01 ether, 0.01 ether);
        vm.recordLogs();
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0.01 ether, abi.encodeWithSelector(sink.ping.selector, 5));
        uint256 balance = address(wallet104).balance;
        uint256 executions = wallet104.executionCount();
        uint256 epoch = wallet104.authEpoch();
        address wallet = address(wallet104);

        _release(wallet104, alice, bob);
        vm.prank(bob);
        nft.transfer(carol, 104);
        vm.prank(carol);
        nft.transfer(alice, 104);

        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 6));

        _deposit(wallet104, alice, 104);
        vm.expectRevert(CitizenAccountV2.StaleEpoch.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 6));

        assertEq(address(wallet104), wallet);
        assertEq(address(wallet104).balance, balance);
        assertEq(wallet104.executionCount(), executions);
        assertTrue(wallet104.authEpoch() > epoch);
        assertTrue(wallet104.sessionDead());
        assertTrue(wallet104.sessionEpoch() != wallet104.authEpoch());
        _assertExecutedLog(wallet);
        _assertIdentity(wallet104, 104, balance, executions);
    }

    function testRevokedSessionStaysDeadWhenOwnershipReturns() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        vm.prank(alice);
        wallet104.revokeSession();
        vm.expectRevert(CitizenAccountV2.StaleEpoch.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));

        _release(wallet104, alice, bob);
        vm.prank(bob);
        nft.transfer(carol, 104);
        vm.prank(carol);
        nft.transfer(alice, 104);
        _deposit(wallet104, alice, 104);

        vm.expectRevert(CitizenAccountV2.StaleEpoch.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        assertEq(sink.lastValue(), 0);
        assertEq(address(wallet104).balance, 1 ether);
    }

    function testCurrentOwnerOpensAFreshSession() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        _release(wallet104, alice, bob);
        vm.prank(bob);
        nft.transfer(carol, 104);

        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(carol);
        wallet104.openSession(_params(executorB, address(sink), sink.ping.selector, 0, 0, address(0), 0, 0));

        _deposit(wallet104, carol, 104);
        vm.expectRevert(CitizenAccountV2.StaleEpoch.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));

        _open(wallet104, carol, executorB, 0.02 ether, 0.02 ether);
        vm.prank(executorB);
        wallet104.executeSession(0, address(sink), 0.02 ether, abi.encodeWithSelector(sink.ping.selector, 9));
        assertEq(sink.lastCaller(), address(wallet104));
        assertEq(sink.lastValue(), 9);
        assertEq(wallet104.authority(), carol);
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 10));
    }

    function testSpendLimitBypassFails() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0.05 ether, 0.05 ether);
        uint256 balance = address(wallet104).balance;

        vm.expectRevert(CitizenAccountV2.ValueNotAllowed.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0.06 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0.05 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.expectRevert(CitizenAccountV2.SpendLimit.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(sink), 0.01 ether, abi.encodeWithSelector(sink.ping.selector, 2));
        vm.expectRevert(CitizenAccountV2.Replay.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 2));
        vm.expectRevert(CitizenAccountV2.TargetNotAllowed.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(token), 0, abi.encodeWithSelector(token.transfer.selector, bob, 1));
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(executor);
        wallet104.execute(address(sink), 0.5 ether, abi.encodeWithSelector(sink.ping.selector, 3));
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(executor);
        wallet104.release(executor);
        assertFalse(_upgrade(address(wallet104), address(new HostileWallet(executor))));
        assertEq(wallet104.implementation(), address(implementation));
        vm.expectRevert(CitizenAccountV2.ApprovalDisabled.selector);
        vm.prank(alice);
        wallet104.execute(address(token), 0, abi.encodeWithSelector(token.approve.selector, executor, type(uint256).max));

        assertEq(address(wallet104).balance, balance - 0.05 ether);
        assertEq(token.balanceOf(address(wallet104)), 1_000);
        assertEq(wallet104.sessionNonce(), 1);
        assertEq(wallet104.sessionValueSpent(), 0.05 ether);
    }

    function testTokenBudgetCatchesHiddenPullAndDeclaredTransfer() public {
        _deposit(wallet104, alice, 104);
        TokenGrabber grabber = new TokenGrabber();
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(grabber), grabber.grab.selector, 0, 0, address(token), 10, 10));

        vm.expectRevert(CitizenAccountV2.TokenSpendLimit.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(grabber), 0, abi.encodeWithSelector(grabber.grab.selector, address(token), address(wallet104), 11));
        assertEq(token.balanceOf(address(wallet104)), 1_000);

        vm.prank(executor);
        wallet104.executeSession(0, address(grabber), 0, abi.encodeWithSelector(grabber.grab.selector, address(token), address(wallet104), 10));
        assertEq(token.balanceOf(address(wallet104)), 990);
        assertEq(wallet104.sessionTokenSpent(), 10);
        vm.expectRevert(CitizenAccountV2.TokenSpendLimit.selector);
        vm.prank(executor);
        wallet104.executeSession(1, address(grabber), 0, abi.encodeWithSelector(grabber.grab.selector, address(token), address(wallet104), 1));

        vm.prank(alice);
        wallet104.revokeSession();
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(token), token.transfer.selector, 0, 0, address(token), 4, 4));
        vm.expectRevert(CitizenAccountV2.TokenSpendLimit.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(token), 0, abi.encodeWithSelector(token.transfer.selector, bob, 5));
        vm.prank(executor);
        wallet104.executeSession(0, address(token), 0, abi.encodeWithSelector(token.transfer.selector, bob, 4));
        assertEq(token.balanceOf(bob), 4);
        assertEq(token.balanceOf(address(wallet104)), 986);
        vm.expectRevert(CitizenAccountV2.ApprovalDisabled.selector);
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(token), token.approve.selector, 0, 0, address(token), 1, 1));
    }

    function testHumanExecuteRetiresTheSession() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        vm.prank(alice);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 3));
        vm.expectRevert(CitizenAccountV2.StaleEpoch.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 4));
    }

    function testUnsafePushFreezesAndDoesNotReviveOrAuthorize() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        _release(wallet104, alice, alice);
        uint256 balance = address(wallet104).balance;

        vm.prank(alice);
        nft.transferFrom(alice, address(wallet104), 104);
        assertEq(nft.ownerOf(104), address(wallet104));
        assertEq(wallet104.custodyOpen(), false);
        assertEq(wallet104.authority(), address(0));

        vm.expectRevert(CitizenAccountV2.UntrackedCustody.selector);
        vm.prank(alice);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.expectRevert(CitizenAccountV2.UntrackedCustody.selector);
        vm.prank(alice);
        wallet104.deposit();
        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(alice);
        wallet104.release(alice);
        assertFalse(_upgrade(address(wallet104), address(new HostileWallet(alice))));
        assertEq(wallet104.implementation(), address(implementation));
        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.expectRevert(CitizenAccountV2.UntrackedCustody.selector);
        vm.prank(bob);
        wallet104.execute(address(sink), 1 ether, abi.encodeWithSelector(sink.ping.selector, 1));

        assertEq(address(wallet104).balance, balance);
        assertEq(token.balanceOf(address(wallet104)), 1_000);
        _assertIdentity(wallet104, 104, balance, 0);
    }

    function testSafePushIsRejected() public {
        vm.expectRevert(MockGenesisNFT.UnsafeReceiver.selector);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(wallet104), 104);
        assertEq(nft.ownerOf(104), alice);
        assertEq(wallet104.custodyOpen(), false);
    }

    function testFormerOwnerCannotInstallABackdoorOrDrainFutureDeposits() public {
        HostileWallet door = new HostileWallet(alice);
        address wallet = address(wallet104);
        assertEq(wallet104.implementation(), address(implementation));

        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        assertEq(address(uint160(uint256(vm.load(wallet, slot)))), address(implementation));
        vm.prank(alice);
        assertFalse(_upgrade(wallet, address(door)));
        assertEq(address(uint160(uint256(vm.load(wallet, slot)))), address(implementation));
        assertEq(wallet104.implementation(), address(implementation));
        assertEq(CitizenWalletProxy(payable(wallet)).logic(), address(implementation));
        assertEq(wallet104.codeVersion(), 1);

        vm.prank(alice);
        nft.transfer(bob, 104);
        vm.deal(wallet, 2 ether);

        assertFalse(_drain(wallet));
        assertEq(wallet.balance, 2 ether);
        assertEq(alice.balance, 0);
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(alice);
        wallet104.execute(address(sink), 1 ether, abi.encodeWithSelector(sink.ping.selector, 1));

        vm.prank(bob);
        wallet104.execute(address(sink), 0.25 ether, abi.encodeWithSelector(sink.ping.selector, 2));
        vm.expectRevert(CitizenAccountV2.TargetNotAllowed.selector);
        vm.prank(bob);
        wallet104.execute(address(implementation), 0, abi.encodeWithSignature("codeVersion()"));
        vm.expectRevert(CitizenAccountV2.TargetNotAllowed.selector);
        vm.prank(bob);
        wallet104.execute(address(nft), 0, abi.encodeWithSignature("transfer(address,uint256)", alice, 104));
        assertEq(wallet.balance, 1.75 ether);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(wallet, address(wallet104));
        _assertIdentity(wallet104, 104, 1.75 ether, 1);
    }

    function testCustodyUpgradeAttemptDoesNotSurviveRelease() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        HostileWallet door = new HostileWallet(alice);
        vm.prank(alice);
        assertFalse(_upgrade(address(wallet104), address(door)));
        assertEq(wallet104.implementation(), address(implementation));
        assertEq(wallet104.sessionDead(), false);

        _release(wallet104, alice, bob);
        vm.deal(address(wallet104), address(wallet104).balance + 0.5 ether);
        uint256 balance = address(wallet104).balance;
        assertFalse(_drain(address(wallet104)));
        vm.expectRevert(CitizenAccountV2.NotInCustody.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.prank(bob);
        wallet104.execute(address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 3));
        assertEq(address(wallet104).balance, balance);
        assertEq(wallet104.authority(), bob);
        assertEq(wallet104.controller(), address(0));
    }

    function testCorruptedImplementationSlotDoesNotRetargetTheWallet() public {
        HostileWallet door = new HostileWallet(alice);
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        vm.store(address(wallet104), slot, bytes32(uint256(uint160(address(door)))));

        assertEq(wallet104.implementation(), address(implementation));
        vm.prank(alice);
        nft.transfer(bob, 104);
        vm.deal(address(wallet104), 2 ether);
        assertFalse(_drain(address(wallet104)));
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        vm.prank(alice);
        wallet104.execute(address(sink), 2 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.prank(bob);
        wallet104.execute(address(sink), 0.1 ether, abi.encodeWithSelector(sink.ping.selector, 4));
        assertEq(address(wallet104).balance, 1.9 ether);
        assertEq(alice.balance, 0);
    }

    function testHostileFactoryIsNotThePermanentWallet() public {
        nft.mint(alice, 201);
        HostileWallet door = new HostileWallet(alice);
        CitizenAccountFactoryV2 evil = new CitizenAccountFactoryV2(address(door));
        address evilWallet = evil.create(block.chainid, address(nft), 201);
        assertTrue(evilWallet != address(wallet104));
        assertEq(CitizenWalletProxy(payable(evilWallet)).implementation(), address(door));
        vm.deal(evilWallet, 1 ether);
        assertTrue(_drain(evilWallet));
        assertEq(alice.balance, 1 ether);
        assertEq(address(wallet104).balance, 1 ether);
        assertEq(wallet104.implementation(), address(implementation));
    }

    function testKnownApprovalSelectorsStayDisabled() public {
        _deposit(wallet104, alice, 104);
        bytes4[4] memory selectors = [
            bytes4(0x8fcbaf0c),
            bytes4(0xd73dd623),
            bytes4(0xd505accf),
            bytes4(0xa22cb465)
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            vm.expectRevert(CitizenAccountV2.ApprovalDisabled.selector);
            vm.prank(alice);
            wallet104.openSession(_params(executor, address(token), selectors[i], 0, 0, address(token), 1, 1));
            vm.expectRevert(CitizenAccountV2.ApprovalDisabled.selector);
            vm.prank(alice);
            wallet104.execute(address(token), 0, abi.encodePacked(selectors[i], bytes28(0)));
        }
    }

    function testSiblingCitizenIsIsolated() public {
        _deposit(wallet104, alice, 104);
        _deposit(wallet129, alice, 129);
        _open(wallet104, alice, executor, 0.03 ether, 0.03 ether);
        _open(wallet129, alice, executor, 0.03 ether, 0.03 ether);
        address a = address(wallet104);
        address b = address(wallet129);
        assertTrue(a != b);

        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0.03 ether, abi.encodeWithSelector(sink.ping.selector, 1));
        _release(wallet104, alice, bob);
        vm.prank(bob);
        nft.transfer(carol, 104);
        vm.prank(carol);
        nft.transfer(alice, 104);

        vm.prank(executor);
        wallet129.executeSession(0, address(sink), 0.03 ether, abi.encodeWithSelector(sink.ping.selector, 2));
        assertEq(address(wallet129).balance, 1 ether - 0.03 ether);
        assertEq(nft.ownerOf(129), address(wallet129));
        assertEq(wallet129.custodyOpen(), true);
        assertEq(wallet129.sessionDead(), false);
        assertEq(address(wallet104), a);
        assertEq(address(wallet129), b);
        _assertIdentity(wallet129, 129, 1 ether - 0.03 ether, 1);
    }

    function testReentrancyCannotReleaseOrBypassTheBudget() public {
        _deposit(wallet104, alice, 104);
        ReenterRelease probe = new ReenterRelease();
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(probe), probe.ping.selector, 0, 0, address(0), 0, 0));
        vm.prank(executor);
        wallet104.executeSession(0, address(probe), 0, abi.encodeWithSelector(probe.ping.selector, address(wallet104), bob));
        assertEq(nft.ownerOf(104), address(wallet104));
        assertEq(wallet104.custodyOpen(), true);
        assertEq(address(wallet104).balance, 1 ether);
        assertEq(wallet104.sessionNonce(), 1);

        ReenterExecute thief = new ReenterExecute();
        vm.prank(alice);
        wallet104.revokeSession();
        vm.prank(alice);
        wallet104.openSession(_params(executor, address(thief), thief.ping.selector, 0, 0, address(0), 0, 0));
        vm.expectRevert(CitizenAccountV2.Reentrant.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(thief), 0, abi.encodeWithSelector(thief.ping.selector, address(wallet104), address(sink)));
        assertEq(address(wallet104).balance, 1 ether);
        assertEq(nft.ownerOf(104), address(wallet104));
    }

    function testBounceBackCannotForceRelease() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        NftBounce bounce = new NftBounce(nft, 104, address(wallet104));
        uint256 epoch = wallet104.authEpoch();
        vm.expectRevert(CitizenAccountV2.StillHeld.selector);
        vm.prank(alice);
        wallet104.release(address(bounce));
        assertEq(wallet104.authEpoch(), epoch);
        assertEq(wallet104.custodyOpen(), true);
        assertEq(nft.ownerOf(104), address(wallet104));
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        assertEq(sink.lastValue(), 1);
    }

    function testSessionExpiryPauseAndReplay() public {
        _deposit(wallet104, alice, 104);
        _open(wallet104, alice, executor, 0, 0);
        vm.prank(alice);
        wallet104.pauseSession(true);
        vm.expectRevert(CitizenAccountV2.SessionPaused.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
        vm.prank(alice);
        wallet104.pauseSession(false);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(CitizenAccountV2.SessionExpired.selector);
        vm.prank(executor);
        wallet104.executeSession(0, address(sink), 0, abi.encodeWithSelector(sink.ping.selector, 1));
    }

    function testCreateIsIdempotentAndBalancePrecedesCode() public {
        nft.mint(alice, 7);
        address predicted = factory.predict(block.chainid, address(nft), 7);
        vm.deal(predicted, 0.4 ether);
        address created = factory.create(block.chainid, address(nft), 7);
        assertEq(created, predicted);
        assertEq(created.balance, 0.4 ether);
        assertEq(factory.create(block.chainid, address(nft), 7), created);
        assertTrue(created != address(wallet104));
        vm.expectRevert(CitizenAccountFactoryV2.WrongChain.selector);
        factory.create(1, address(nft), 7);
        vm.expectRevert(CitizenAccountV2.AlreadyInitialized.selector);
        CitizenAccountV2(payable(created)).initialize(block.chainid, address(nft), 7);
        vm.expectRevert(CitizenAccountV2.DirectCall.selector);
        implementation.initialize(block.chainid, address(nft), 7);
    }

    function testDeployScriptCannotBroadcastAndV11AddressStaysPinned() public {
        DeployCitizenAccountFactoryV2 script = new DeployCitizenAccountFactoryV2();
        DeployCitizenAccountFactory previous = new DeployCitizenAccountFactory();
        vm.expectRevert(DeployCitizenAccountFactoryV2.BroadcastDisabled.selector);
        script.run();
        assertEq(script.predictFactory().code.length, 0);
        assertEq(script.predictImplementation().code.length, 0);
        assertEq(previous.predictFactory(), 0xA2edAC990B30A488D61fc4607D4365b22e41e39c);
        assertTrue(script.predictFactory() != previous.predictFactory());
        assertTrue(script.predictFactory() != 0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c);
        assertTrue(script.predictAccount(143, GENESIS, 104) != script.predictAccount(143, GENESIS, 129));

        string memory source = vm.readFile("script/DeployCitizenAccountFactoryV2.s.sol");
        assertFalse(_contains(source, "startBroadcast"));

        bytes32 salt = keccak256(abi.encode(block.chainid, address(nft), uint256(104)));
        bytes memory initData = abi.encodeCall(CitizenAccountV2.initialize, (block.chainid, address(nft), uint256(104)));
        bytes32 initHash = keccak256(
            abi.encodePacked(type(CitizenWalletProxy).creationCode, abi.encode(address(implementation), initData))
        );
        assertEq(factory.predict(block.chainid, address(nft), 104), vm.computeCreate2Address(salt, initHash, address(factory)));
        assertEq(address(wallet104), factory.predict(block.chainid, address(nft), 104));

        assertEq(script.predictImplementation(), 0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632);
        assertEq(script.predictFactory(), 0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD);
        assertEq(script.implementationInitCodeHash(), 0x19c106f6993aad95c63cf742ec0eec9323f889a6feefd7ee8897768d216f1251);
        assertEq(script.factoryInitCodeHash(), 0xf949dcca45c301030267e8a46ecc2aabab92a79ad49d147a1b327307f00e1a64);
        assertEq(script.predictAccount(143, GENESIS, 104), 0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502);
        assertEq(script.predictAccount(143, GENESIS, 129), 0x492905adbc786264f0195FAE4516F5275BB3b960);
    }

    function _upgrade(address wallet, address nextImpl) internal returns (bool ok) {
        (ok,) = wallet.call(abi.encodeWithSignature("upgradeTo(address)", nextImpl));
    }

    function _drain(address wallet) internal returns (bool ok) {
        (ok,) = wallet.call(abi.encodeWithSignature("drain()"));
    }

    function _deposit(CitizenAccountV2 wallet, address who, uint256 id) internal {
        vm.startPrank(who);
        nft.approve(address(wallet), id);
        wallet.deposit();
        vm.stopPrank();
    }

    function _release(CitizenAccountV2 wallet, address who, address to) internal {
        vm.prank(who);
        wallet.release(to);
    }

    function _open(CitizenAccountV2 wallet, address who, address executor_, uint256 perCall, uint256 cumulative) internal {
        vm.prank(who);
        wallet.openSession(_params(executor_, address(sink), sink.ping.selector, perCall, cumulative, address(0), 0, 0));
    }

    function _params(
        address executor_,
        address target,
        bytes4 selector,
        uint256 perCall,
        uint256 cumulative,
        address spendToken,
        uint256 tokenPerCall,
        uint256 tokenCumulative
    ) internal pure returns (CitizenAccountV2.SessionParams memory) {
        return CitizenAccountV2.SessionParams({
            executor: executor_,
            target: target,
            selector: selector,
            maxValuePerCall: perCall,
            maxCumulativeValue: cumulative,
            spendToken: spendToken,
            maxTokenPerCall: tokenPerCall,
            maxTokenCumulative: tokenCumulative,
            ttlSeconds: 1 days
        });
    }

    function _assertIdentity(CitizenAccountV2 wallet, uint256 id, uint256 balance, uint256 executions) internal view {
        (uint256 chainId_, address nft_, uint256 tokenId_) = wallet.token();
        assertEq(chainId_, block.chainid);
        assertEq(nft_, address(nft));
        assertEq(tokenId_, id);
        assertEq(address(wallet).balance, balance);
        assertEq(wallet.executionCount(), executions);
        assertEq(address(wallet), factory.predict(block.chainid, address(nft), id));
    }

    function _assertExecutedLog(address wallet) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == wallet && logs[i].topics[0] == EXECUTED) found = true;
        }
        assertTrue(found);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
