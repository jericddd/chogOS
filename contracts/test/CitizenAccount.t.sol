// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CitizenAccount} from "../src/CitizenAccount.sol";
import {CitizenAccountFactory} from "../src/CitizenAccountFactory.sol";
import {DeployCitizenAccountFactory} from "../script/DeployCitizenAccountFactory.s.sol";
import {MockGenesisNFT, MockSink} from "./MockGenesisNFT.sol";
import {OwnerAtGrantPreview} from "./OwnerAtGrantPreview.sol";

contract CitizenAccountTest is Test {
    CitizenAccountFactory internal factory;
    MockGenesisNFT internal nft;
    MockSink internal sink;
    MockSink internal otherSink;
    CitizenAccount internal account;
    OwnerAtGrantPreview internal preview;

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
        preview = new OwnerAtGrantPreview(account);
    }

    function testPredictMatchesCreateAndIsIdempotent() public {
        address predicted = factory.predict(block.chainid, address(nft), tokenId);
        assertEq(predicted, address(account));
        address second = factory.create(block.chainid, address(nft), tokenId);
        assertEq(second, address(account));
        address other = factory.create(block.chainid, address(nft), 8);
        assertTrue(other != address(account));
        assertEq(other, factory.predict(block.chainid, address(nft), 8));
        vm.expectRevert(CitizenAccountFactory.WrongChain.selector);
        factory.create(1, address(nft), 9);
    }

    function testAccountCreate2MatchesComputeCreate2Address() public view {
        bytes32 salt = factory.accountSalt(block.chainid, address(nft), tokenId);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(CitizenAccount).creationCode, abi.encode(block.chainid, address(nft), tokenId))
        );
        assertEq(factory.predict(block.chainid, address(nft), tokenId), vm.computeCreate2Address(salt, initCodeHash, address(factory)));
        assertEq(address(account), vm.computeCreate2Address(salt, initCodeHash, address(factory)));
    }

    function testFactoryCreate2SaltMatchesDeployScript() public {
        DeployCitizenAccountFactory script = new DeployCitizenAccountFactory();
        bytes32 salt = script.FACTORY_SALT();
        assertEq(salt, keccak256("chogOS.CitizenAccountFactory.v1.1"));
        assertEq(script.DETERMINISTIC_CREATE2(), 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        CitizenAccountFactory created = new CitizenAccountFactory{salt: salt}();
        assertEq(
            address(created),
            vm.computeCreate2Address(salt, keccak256(type(CitizenAccountFactory).creationCode), address(this))
        );
        assertEq(script.predictFactory(address(this)), vm.computeCreate2Address(salt, script.factoryInitCodeHash(), address(this)));
        assertEq(script.predictFactory(), vm.computeCreate2Address(salt, script.factoryInitCodeHash()));
        assertEq(script.predictFactory(), vm.computeCreate2Address(salt, script.factoryInitCodeHash(), script.DETERMINISTIC_CREATE2()));
        assertTrue(script.predictFactory() != 0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c);
        assertEq(script.predictFactory(), 0xA2edAC990B30A488D61fc4607D4365b22e41e39c);
    }

    function testPinnedCompilerSettings() public view {
        string memory toml = vm.readFile("foundry.toml");
        assertTrue(_contains(toml, "solc = \"0.8.28\""));
        assertTrue(_contains(toml, "optimizer = true"));
        assertTrue(_contains(toml, "optimizer_runs = 200"));
        assertTrue(_contains(toml, "evm_version = \"cancun\""));
        assertTrue(_contains(toml, "via_ir = false"));
        assertTrue(_contains(toml, "bytecode_hash = \"ipfs\""));
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

    function testSessionFollowsOwnerAndLatchesOnObservedTransfer() public {
        vm.prank(walletA);
        account.openSession(executor, address(sink), pingSelector, 0, 0, 1 days);
        vm.prank(executor);
        account.executeSession(0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
        assertEq(sink.lastValue(), 1);

        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        account.syncOwner();
        vm.expectRevert(CitizenAccount.SessionDead.selector);
        vm.prank(executor);
        account.executeSession(1, address(sink), 0, abi.encodeWithSelector(pingSelector, 2));

        vm.prank(walletB);
        nft.transfer(walletA, tokenId);
        vm.expectRevert(CitizenAccount.SessionDead.selector);
        vm.prank(executor);
        account.executeSession(1, address(sink), 0, abi.encodeWithSelector(pingSelector, 3));
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 4));
        assertEq(sink.lastValue(), 4);
    }

    function testRoundTripWithoutSyncStillNeedsInvalidation() public {
        vm.prank(walletA);
        account.openSession(executor, address(sink), pingSelector, 0, 0, 1 days);

        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.prank(walletB);
        nft.transfer(walletA, tokenId);

        vm.prank(executor);
        account.executeSession(0, address(sink), 0, abi.encodeWithSelector(pingSelector, 8));
        assertEq(sink.lastValue(), 8);

        vm.prank(executor);
        account.invalidateSession();
        vm.prank(executor);
        vm.expectRevert(CitizenAccount.SessionDead.selector);
        account.executeSession(1, address(sink), 0, abi.encodeWithSelector(pingSelector, 9));
    }

    function testSessionLimitsRevokePauseAndReplay() public {
        vm.deal(address(account), 1 ether);
        vm.prank(walletA);
        account.openSession(executor, address(sink), pingSelector, 0.05 ether, 0.05 ether, 1 days);
        vm.expectRevert(CitizenAccount.ValueNotAllowed.selector);
        vm.prank(executor);
        account.executeSession(0, address(sink), 0.06 ether, abi.encodeWithSelector(pingSelector, 1));
        vm.prank(executor);
        account.executeSession(0, address(sink), 0.05 ether, abi.encodeWithSelector(pingSelector, 1));
        vm.expectRevert(CitizenAccount.SpendLimit.selector);
        vm.prank(executor);
        account.executeSession(1, address(sink), 0.01 ether, abi.encodeWithSelector(pingSelector, 2));
        vm.expectRevert(CitizenAccount.Replay.selector);
        vm.prank(executor);
        account.executeSession(0, address(sink), 0, abi.encodeWithSelector(pingSelector, 2));
        vm.expectRevert(CitizenAccount.TargetNotAllowed.selector);
        vm.prank(executor);
        account.executeSession(1, address(otherSink), 0, abi.encodeWithSelector(pingSelector, 2));

        vm.prank(walletA);
        account.pauseSession(true);
        vm.expectRevert(CitizenAccount.SessionPaused.selector);
        vm.prank(executor);
        account.executeSession(1, address(sink), 0, abi.encodeWithSelector(pingSelector, 2));
        vm.prank(walletA);
        account.revokeSession();
        vm.expectRevert(CitizenAccount.SessionDead.selector);
        vm.prank(executor);
        account.executeSession(1, address(sink), 0, abi.encodeWithSelector(pingSelector, 2));
    }

    function testV1DelegationEntrypointsAreDisabled() public {
        vm.expectRevert(CitizenAccount.DelegationDisabled.selector);
        vm.prank(walletA);
        account.grantDelegation(executor, address(sink), pingSelector, false, uint64(block.timestamp + 1 days));
        vm.expectRevert(CitizenAccount.DelegationDisabled.selector);
        vm.prank(walletA);
        account.revokeDelegation(1);
        vm.expectRevert(CitizenAccount.DelegationDisabled.selector);
        vm.prank(executor);
        account.executeDelegated(1, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
    }

    function testOwnerAtGrantRevivesAfterTransferCycle() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = preview.grant(executor, address(sink), pingSelector, false, expiry);

        vm.prank(executor);
        preview.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
        assertEq(sink.lastValue(), 1);

        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.expectRevert(OwnerAtGrantPreview.NotNftOwner.selector);
        vm.prank(executor);
        preview.executeDelegated(id, 1, address(sink), 0, abi.encodeWithSelector(pingSelector, 2));

        vm.prank(walletB);
        nft.transfer(walletA, tokenId);
        vm.prank(executor);
        preview.executeDelegated(id, 1, address(sink), 0, abi.encodeWithSelector(pingSelector, 3));
        assertEq(sink.lastValue(), 3);
        assertEq(account.currentOwner(), walletA);
    }

    function testOwnerAtGrantWithSecondHopAndBGrant() public {
        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.prank(walletA);
        uint256 fromA = preview.grant(executor, address(sink), pingSelector, false, expiry);

        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.expectRevert(OwnerAtGrantPreview.NotNftOwner.selector);
        vm.prank(executor);
        preview.executeDelegated(fromA, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.prank(walletB);
        uint256 fromB = preview.grant(executor, address(sink), pingSelector, false, expiry);
        vm.prank(executor);
        preview.executeDelegated(fromB, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 4));
        assertEq(sink.lastValue(), 4);

        vm.prank(walletB);
        nft.transfer(walletC, tokenId);
        vm.expectRevert(OwnerAtGrantPreview.NotNftOwner.selector);
        vm.prank(executor);
        preview.executeDelegated(fromA, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 5));
        vm.expectRevert(OwnerAtGrantPreview.NotNftOwner.selector);
        vm.prank(executor);
        preview.executeDelegated(fromB, 1, address(sink), 0, abi.encodeWithSelector(pingSelector, 5));

        vm.prank(walletC);
        nft.transfer(walletB, tokenId);
        vm.prank(executor);
        preview.executeDelegated(fromB, 1, address(sink), 0, abi.encodeWithSelector(pingSelector, 6));
        assertEq(sink.lastValue(), 6);
        vm.expectRevert(OwnerAtGrantPreview.NotNftOwner.selector);
        vm.prank(executor);
        preview.executeDelegated(fromA, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 7));
    }

    function testOwnerAtGrantRevokeAndExpiryStillWork() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(walletA);
        uint256 id = preview.grant(executor, address(sink), pingSelector, true, expiry);
        vm.prank(walletA);
        preview.revoke(id);
        vm.expectRevert(OwnerAtGrantPreview.DelegationInvalid.selector);
        vm.prank(executor);
        preview.executeDelegated(id, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.prank(walletA);
        uint256 fresh = preview.grant(executor, address(sink), pingSelector, false, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        vm.expectRevert(OwnerAtGrantPreview.Expired.selector);
        vm.prank(executor);
        preview.executeDelegated(fresh, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));

        vm.prank(walletA);
        uint256 live = preview.grant(executor, address(otherSink), pingSelector, false, uint64(block.timestamp + 1 days));
        vm.expectRevert(OwnerAtGrantPreview.TargetNotAllowed.selector);
        vm.prank(executor);
        preview.executeDelegated(live, 0, address(sink), 0, abi.encodeWithSelector(pingSelector, 1));
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

    function testDeployScriptRefusesNonMainnet() public {
        DeployCitizenAccountFactory script = new DeployCitizenAccountFactory();
        vm.expectRevert(abi.encodeWithSelector(DeployCitizenAccountFactory.NotMonadMainnet.selector, block.chainid));
        script.run();
    }

    function testConstructorGuards() public {
        vm.expectRevert(CitizenAccount.ZeroChain.selector);
        new CitizenAccount(0, address(nft), tokenId);
        vm.expectRevert(CitizenAccount.WrongChain.selector);
        new CitizenAccount(1, address(0), tokenId);
        vm.expectRevert(CitizenAccountFactory.ZeroChain.selector);
        factory.create(0, address(nft), 9);
        vm.expectRevert(CitizenAccountFactory.ZeroAddress.selector);
        factory.create(block.chainid, address(0), 9);
    }

    function testIdentityIsStableAcrossTransfers() public {
        (uint256 chainId_, address nft_, uint256 id_) = account.token();
        vm.prank(walletA);
        nft.transfer(walletB, tokenId);
        vm.prank(walletB);
        nft.transfer(walletA, tokenId);
        (uint256 chainId2, address nft2, uint256 id2) = account.token();
        assertEq(chainId_, chainId2);
        assertEq(nft_, nft2);
        assertEq(id_, id2);
        assertEq(address(account), factory.predict(block.chainid, address(nft), tokenId));
        vm.prank(walletA);
        account.execute(address(sink), 0, abi.encodeWithSelector(pingSelector, 9));
        assertEq(sink.lastValue(), 9);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }
}
