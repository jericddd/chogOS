// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CitizenAccountV3} from "../src/CitizenAccountV3.sol";
import {CitizenAccountFactoryV3} from "../src/CitizenAccountFactoryV3.sol";
import {MockGenesisNFT} from "./MockGenesisNFT.sol";

contract SpendToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev The V3 wallet is the citizen account. NFT holders are not signers.
contract CitizenAccountV3Test is Test {
    uint256 internal constant AGENT_KEY = 0xA9E47;

    address internal agent;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    MockGenesisNFT internal nft;
    CitizenAccountFactoryV3 internal factory;
    CitizenAccountV3 internal wallet;

    function setUp() public {
        vm.chainId(143);
        agent = vm.addr(AGENT_KEY);
        nft = new MockGenesisNFT();
        nft.mint(alice, 104);
        CitizenAccountV3 implementation = new CitizenAccountV3(agent);
        factory = new CitizenAccountFactoryV3(address(implementation));
        wallet = CitizenAccountV3(payable(_create(104, keccak256("first"))));
    }

    function testACitizenWalletDoesNotFollowTheNftHolder() public {
        vm.deal(address(wallet), 1 ether);
        vm.prank(alice);
        nft.transferFrom(alice, bob, 104);
        assertEq(factory.predict(143, address(nft), 104), address(wallet));
        (uint256 chainId_, address nft_, uint256 id_) = wallet.token();
        assertEq(chainId_, 143);
        assertEq(nft_, address(nft));
        assertEq(id_, 104);

        vm.prank(bob);
        vm.expectRevert(CitizenAccountV3.BadSigner.selector);
        wallet.execute(keccak256("bob"), bob, 1 ether, hex"", block.timestamp + 1 hours, _fake());
        vm.prank(alice);
        vm.expectRevert(CitizenAccountV3.BadSigner.selector);
        wallet.execute(keccak256("alice"), alice, 1 ether, hex"", block.timestamp + 1 hours, _fake());

        _act(keccak256("pay"), bob, 0.25 ether, hex"");
        assertEq(bob.balance, 0.25 ether);
        assertEq(address(wallet).balance, 0.75 ether);
        vm.prank(bob);
        nft.transferFrom(bob, alice, 104);
        _act(keccak256("pay-again"), alice, 0.25 ether, hex"");
        assertEq(address(wallet), factory.predict(143, address(nft), 104));
    }

    function testIssuanceIsRequiredReplayableAndStable() public {
        nft.mint(alice, 7);
        uint256 far = block.timestamp + 2 days;
        bytes memory farSig = _issue(7, keccak256("far"), far);
        vm.expectRevert(CitizenAccountFactoryV3.DeadlineTooFar.selector);
        factory.create(143, address(nft), 7, keccak256("far"), far, farSig);

        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(CitizenAccountFactoryV3.BadSigner.selector);
        factory.create(143, address(nft), 7, keccak256("bad"), deadline, _fake());

        bytes memory signature = _issue(7, keccak256("ok"), deadline);
        address created = factory.create(143, address(nft), 7, keccak256("ok"), deadline, signature);
        assertEq(created, factory.predict(143, address(nft), 7));
        assertEq(factory.create(143, address(nft), 7, keccak256("other"), deadline, _fake()), created);
        vm.warp(deadline + 1);
        assertEq(factory.create(143, address(nft), 7, keccak256("late"), deadline, _fake()), created);

        vm.expectRevert(CitizenAccountFactoryV3.WrongChain.selector);
        factory.create(10143, address(nft), 7, keccak256("chain"), block.timestamp + 10 minutes, signature);
    }

    function testExpiredReplayedAndForeignActionsFail() public {
        vm.deal(address(wallet), 1 ether);
        uint256 far = block.timestamp + 2 days;
        bytes memory farSig = _action(keccak256("far"), alice, 1, hex"", far);
        vm.expectRevert(CitizenAccountV3.DeadlineTooFar.selector);
        wallet.execute(keccak256("far"), alice, 1, hex"", far, farSig);

        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory signature = _action(keccak256("once"), alice, 1, hex"", deadline);
        wallet.execute(keccak256("once"), alice, 1, hex"", deadline, signature);
        vm.expectRevert(CitizenAccountV3.Replay.selector);
        wallet.execute(keccak256("once"), alice, 1, hex"", deadline, signature);

        bytes memory late = _action(keccak256("late"), alice, 1, hex"", deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(CitizenAccountV3.Expired.selector);
        wallet.execute(keccak256("late"), alice, 1, hex"", deadline, late);
    }

    function testTheWalletCanTransferATokenAndCannotTouchTheNftOrItself() public {
        SpendToken token = new SpendToken();
        token.mint(address(wallet), 5 ether);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", alice, 2 ether);
        _act(keccak256("token"), address(token), 0, data);
        assertEq(token.balanceOf(alice), 2 ether);
        assertEq(token.balanceOf(address(wallet)), 3 ether);

        bytes memory nftData = abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, 104);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory nftSig = _action(keccak256("nft"), address(nft), 0, nftData, deadline);
        vm.expectRevert(CitizenAccountV3.TargetNotAllowed.selector);
        wallet.execute(keccak256("nft"), address(nft), 0, nftData, deadline, nftSig);
        bytes memory selfSig = _action(keccak256("self"), address(wallet), 0, hex"", deadline);
        vm.expectRevert(CitizenAccountV3.TargetNotAllowed.selector);
        wallet.execute(keccak256("self"), address(wallet), 0, hex"", deadline, selfSig);
        (bool ok,) = address(wallet).call(abi.encodeWithSignature("upgradeTo(address)", alice));
        assertFalse(ok);
    }

    function testUnsafeNftPushDoesNotAuthorizeTheHolder() public {
        vm.deal(address(wallet), 1 ether);
        vm.prank(alice);
        nft.transferFrom(alice, address(wallet), 104);
        assertEq(nft.ownerOf(104), address(wallet));
        _act(keccak256("after-push"), alice, 1 ether, hex"");
        assertEq(alice.balance, 1 ether);
        nft.mint(bob, 8);
        vm.expectRevert(MockGenesisNFT.UnsafeReceiver.selector);
        vm.prank(bob);
        nft.safeTransferFrom(bob, address(wallet), 8);
    }

    function _create(uint256 tokenId, bytes32 decisionId) internal returns (address) {
        uint256 deadline = block.timestamp + 30 minutes;
        return factory.create(143, address(nft), tokenId, decisionId, deadline, _issue(tokenId, decisionId, deadline));
    }

    function _issue(uint256 tokenId, bytes32 decisionId, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, factory.issuanceDigest(143, address(nft), tokenId, decisionId, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _action(bytes32 actionId, address target, uint256 value, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        bytes32 digest = wallet.actionDigest(actionId, target, value, keccak256(data), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _act(bytes32 actionId, address target, uint256 value, bytes memory data) internal {
        uint256 deadline = block.timestamp + 20 minutes;
        wallet.execute(actionId, target, value, data, deadline, _action(actionId, target, value, data, deadline));
    }

    function _fake() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
    }
}
