// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CitizenAccount} from "../src/CitizenAccount.sol";
import {CitizenAccountFactory} from "../src/CitizenAccountFactory.sol";
import {DeployCitizenAccountFactory} from "../script/DeployCitizenAccountFactory.s.sol";
import {MockSink} from "./MockGenesisNFT.sol";

interface IChogGenesis {
    function name() external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @dev Local Mainnet fork only. Skipping when chain id is not 143.
/// This is not evidence of a deployed chogOS factory on Monad.
contract GenesisMainnetForkTest is Test {
    address internal constant GENESIS = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    uint256 internal constant TOKEN = 1;

    modifier mainnetFork() {
        if (block.chainid != 143) {
            vm.skip(true);
        }
        _;
    }

    function testGenesisBytecodeAndOwnerOf() public mainnetFork {
        IChogGenesis nft = IChogGenesis(GENESIS);
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(GENESIS)
        }
        assertGt(codeSize, 0);
        assertEq(nft.name(), "Chog Genesis");
        address owner = nft.ownerOf(TOKEN);
        assertTrue(owner != address(0));
        vm.expectRevert();
        nft.ownerOf(0);
        emit log_named_uint("genesisCodeSize", codeSize);
        emit log_named_bytes32("genesisCodehash", GENESIS.codehash);
    }

    function testForkAccountFollowsRealOwnerOfAndKeepsDelegationDisabled() public mainnetFork {
        IChogGenesis nft = IChogGenesis(GENESIS);
        address owner = nft.ownerOf(TOKEN);
        CitizenAccountFactory factory = new CitizenAccountFactory();
        uint256 gasBefore = gasleft();
        CitizenAccount account = CitizenAccount(payable(factory.create(143, GENESIS, TOKEN)));
        emit log_named_uint("createAccountGasApprox", gasBefore - gasleft());
        assertEq(account.currentOwner(), owner);
        vm.expectRevert(CitizenAccountFactory.WrongChain.selector);
        factory.create(10143, GENESIS, TOKEN);
        (uint256 chainId_, address nft_, uint256 id_) = account.token();
        assertEq(chainId_, 143);
        assertEq(nft_, GENESIS);
        assertEq(id_, TOKEN);

        MockSink sink = new MockSink();
        vm.prank(owner);
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.ping.selector, 21));
        assertEq(sink.lastValue(), 21);

        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(address(0xB0B));
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.ping.selector, 22));

        vm.expectRevert(CitizenAccount.DelegationDisabled.selector);
        vm.prank(owner);
        account.grantDelegation(address(0xE1), address(sink), MockSink.ping.selector, false, uint64(block.timestamp + 1 days));

        address other = address(0xB0B);
        vm.prank(owner);
        nft.transferFrom(owner, other, TOKEN);
        assertEq(account.currentOwner(), other);
        vm.expectRevert(CitizenAccount.NotNftOwner.selector);
        vm.prank(owner);
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.ping.selector, 23));
        vm.prank(other);
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.ping.selector, 24));
        assertEq(sink.lastValue(), 24);

        vm.prank(other);
        nft.transferFrom(other, owner, TOKEN);
        assertEq(account.currentOwner(), owner);
        vm.prank(owner);
        account.execute(address(sink), 0, abi.encodeWithSelector(MockSink.ping.selector, 25));
        assertEq(sink.lastValue(), 25);
        (uint256 chainId2, address nft2, uint256 id2) = account.token();
        assertEq(chainId_, chainId2);
        assertEq(nft_, nft2);
        assertEq(id_, id2);
    }

    function testDeployScriptCreate2OnMainnetFork() public mainnetFork {
        DeployCitizenAccountFactory script = new DeployCitizenAccountFactory();
        assertEq(script.DETERMINISTIC_CREATE2().code.length, 69);
        assertEq(script.predictFactory().code.length, 0, "predicted factory is not deployed on Mainnet");
        CitizenAccountFactory factory = script.run();
        assertEq(address(factory), script.predictFactory());
        assertGt(address(factory).code.length, 0);
        assertEq(block.chainid, 143);
        emit log_named_uint("factoryCodeSize", address(factory).code.length);
        emit log_named_address("forkFactory", address(factory));
        emit log_named_address("predictedFactory", script.predictFactory());
    }
}
