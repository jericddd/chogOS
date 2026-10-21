// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ChogBank} from "../src/ChogBank.sol";
import {CitizenAccountFactoryV2} from "../src/CitizenAccountFactoryV2.sol";
import {CitizenAccountV2} from "../src/CitizenAccountV2.sol";
import {DeployChogBank} from "../script/DeployChogBank.s.sol";
import {DeployCitizenAccountFactoryV2} from "../script/DeployCitizenAccountFactoryV2.s.sol";
import {DeployCitizenWallets} from "../script/DeployCitizenWallets.s.sol";
import {ChogBankPayout} from "../script/ChogBankPayout.s.sol";
import {MockGenesisNFT} from "./MockGenesisNFT.sol";

contract MockChog {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract SilentChog {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

contract FalseChog {
    function balanceOf(address) external pure returns (uint256) {
        return 100 ether;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract ShortChog {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 sent = amount / 2;
        balanceOf[msg.sender] -= sent;
        balanceOf[to] += sent;
        return true;
    }
}

contract ReenterChog {
    mapping(address => uint256) public balanceOf;
    ChogBank public bank;
    bytes32 public otherId;
    uint256 public otherTokenId;
    uint256 public otherAmount;
    uint256 public otherDeadline;
    bytes32 public otherReason;
    bytes public otherSig;
    uint256 public attacks;

    function arm(ChogBank bank_, bytes32 decisionId, uint256 tokenId, uint256 amount, uint256 deadline, bytes32 reasonHash) external {
        bank = bank_;
        otherId = decisionId;
        otherTokenId = tokenId;
        otherAmount = amount;
        otherDeadline = deadline;
        otherReason = reasonHash;
    }

    function armSignature(bytes calldata signature) external {
        otherSig = signature;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        attacks += 1;
        if (attacks == 1 && address(bank) != address(0)) {
            try bank.distribute(otherId, otherTokenId, address(this), otherAmount, otherDeadline, otherReason, otherSig) {}
            catch {}
        }
        return true;
    }
}

contract ChogBankTest is Test {
    uint256 internal constant AUTHORIZER_KEY = 0xA11CE;
    bytes32 internal constant EIP712_FIXTURE = 0x9e8d7964415e5c69eb7f07794a255765113711d7caf35f311dbfba4824464ee8;
    bytes32 internal constant REASON_BECAUSE = 0x28b81c8e4912ea69e000b26a50fadf183c10d66be8b43a192a361b6d38a1d464;

    address internal authorizer;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    MockGenesisNFT internal nft;
    MockChog internal chog;
    CitizenAccountV2 internal implementation;
    CitizenAccountFactoryV2 internal factory;
    ChogBank internal bank;
    address internal wallet104;

    function setUp() public {
        vm.chainId(143);
        authorizer = vm.addr(AUTHORIZER_KEY);
        nft = new MockGenesisNFT();
        chog = new MockChog();
        implementation = new CitizenAccountV2();
        factory = new CitizenAccountFactoryV2(address(implementation));
        bank = _bank(address(nft), address(chog), 1 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        nft.mint(alice, 104);
        nft.mint(alice, 129);
        wallet104 = factory.create(143, address(nft), 104);
    }

    function testFundingMonAndChog() public {
        vm.expectEmit(true, true, false, true);
        emit ChogBank.Funded(alice, address(0), 1 ether);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(bank).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(bank).balance, 1 ether);

        chog.mint(alice, 5 ether);
        vm.prank(alice);
        chog.approve(address(bank), 5 ether);
        vm.expectEmit(true, true, false, true);
        emit ChogBank.Funded(alice, address(chog), 5 ether);
        vm.prank(alice);
        bank.depositChog(5 ether);
        assertEq(chog.balanceOf(address(bank)), 5 ether);

        chog.mint(address(bank), 1 ether);
        assertEq(chog.balanceOf(address(bank)), 6 ether);
    }

    function testZeroMonFundingReverts() public {
        (bool ok,) = address(bank).call{value: 0}("");
        assertFalse(ok);
    }

    function testAuthorizedMonDistribution() public {
        vm.deal(address(bank), 2 ether);
        bytes32 id = keccak256("mon-104");
        _attempt(bank, id, 104, address(0), 0.4 ether);
        assertEq(wallet104.balance, 0.4 ether);
        assertEq(address(bank).balance, 1.6 ether);
        assertTrue(bank.usedDecision(id));
        assertEq(nft.ownerOf(104), alice);
    }

    function testHolderWithdrawsThePayoutAndANewHolderControlsWhatRemains() public {
        vm.deal(address(bank), 1 ether);
        uint256 gasBefore = gasleft();
        _attempt(bank, keccak256("pay-104"), 104, address(0), 0.2 ether);
        console2.log("local distribute gas", gasBefore - gasleft());
        assertEq(wallet104.balance, 0.2 ether);
        assertEq(bank.payoutRecipient(104), wallet104);

        vm.prank(alice);
        CitizenAccountV2(payable(wallet104)).execute(alice, 0.1 ether, hex"01020304");
        assertEq(alice.balance, 0.1 ether);
        assertEq(wallet104.balance, 0.1 ether);

        vm.prank(alice);
        nft.transferFrom(alice, bob, 104);
        assertEq(bank.citizenWallet(104), wallet104);
        vm.prank(alice);
        vm.expectRevert(CitizenAccountV2.NotAuthorized.selector);
        CitizenAccountV2(payable(wallet104)).execute(alice, 0.1 ether, hex"01020304");
        vm.prank(bob);
        CitizenAccountV2(payable(wallet104)).execute(bob, 0.1 ether, hex"01020304");
        assertEq(bob.balance, 0.1 ether);
        assertEq(wallet104.balance, 0);
    }

    function testCustodyDepositStillAcceptsAndReleasesAPayout() public {
        vm.startPrank(alice);
        nft.approve(wallet104, 104);
        CitizenAccountV2(payable(wallet104)).deposit();
        vm.stopPrank();
        vm.deal(address(bank), 1 ether);
        _attempt(bank, keccak256("custody-104"), 104, address(0), 0.05 ether);
        assertEq(wallet104.balance, 0.05 ether);
        vm.prank(alice);
        CitizenAccountV2(payable(wallet104)).execute(alice, 0.05 ether, hex"01020304");
        assertEq(wallet104.balance, 0);
    }

    function testUnsafeNftTransferFreezesTheWalletAndDoesNotConsumeTheDecision() public {
        vm.deal(address(bank), 1 ether);
        _attempt(bank, keccak256("before-freeze"), 104, address(0), 0.05 ether);
        vm.prank(alice);
        nft.transferFrom(alice, wallet104, 104);
        assertFalse(CitizenAccountV2(payable(wallet104)).custodyOpen());
        bytes32 stuck = keccak256("after-freeze");
        uint256 bankBefore = address(bank).balance;
        uint256 walletBefore = wallet104.balance;
        _expectAttempt(ChogBank.WalletFrozen.selector, bank, stuck, 104, address(0), 0.05 ether);
        assertFalse(bank.usedDecision(stuck));
        assertEq(address(bank).balance, bankBefore);
        assertEq(wallet104.balance, walletBefore);
        vm.prank(alice);
        vm.expectRevert(CitizenAccountV2.UntrackedCustody.selector);
        CitizenAccountV2(payable(wallet104)).execute(alice, 0.01 ether, hex"01020304");
        vm.prank(bob);
        vm.expectRevert(CitizenAccountV2.UntrackedCustody.selector);
        CitizenAccountV2(payable(wallet104)).execute(bob, 0.01 ether, hex"01020304");
    }

    function testAuthorizedChogDistributionUsesRawUnits() public {
        assertEq(chog.decimals(), 18);
        chog.mint(address(bank), 12 ether);
        bytes32 id = keccak256("chog-104");
        _attempt(bank, id, 104, address(chog), 4 ether);
        assertEq(chog.balanceOf(wallet104), 4 ether);
        assertEq(chog.balanceOf(address(bank)), 8 ether);
    }

    function testRejectsUnauthorizedSigner() public {
        vm.deal(address(bank), 5 ether);
        bytes32 id = keccak256("auth");
        uint256 deadline = block.timestamp + 20 minutes;
        bytes32 reason = keccak256("need");
        bytes32 digest = bank.allocationDigest(id, 104, address(0), 0.1 ether, deadline, reason);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        vm.expectRevert(ChogBank.BadSigner.selector);
        bank.distribute(id, 104, address(0), 0.1 ether, deadline, reason, abi.encodePacked(r, s, v));
    }

    function testRejectsExpiredAuthorizationWithoutConsumingIt() public {
        vm.deal(address(bank), 5 ether);
        bytes32 id = keccak256("expired");
        uint256 deadline = block.timestamp + 20 minutes;
        vm.warp(deadline + 1);
        _expectAttemptAt(ChogBank.Expired.selector, bank, id, 104, address(0), 0.1 ether, deadline, keccak256("need"));
        assertFalse(bank.usedDecision(id));
    }

    function testRejectsReplay() public {
        vm.deal(address(bank), 5 ether);
        bytes32 id = keccak256("replay");
        _attempt(bank, id, 104, address(0), 0.1 ether);
        _expectAttempt(ChogBank.Replay.selector, bank, id, 104, address(0), 0.1 ether);
    }

    function testRejectsWrongDomainSignature() public {
        vm.deal(address(bank), 5 ether);
        bytes32 otherId = keccak256("other-domain");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORIZER_KEY, _foreignDigest(otherId));
        vm.expectRevert(ChogBank.BadSigner.selector);
        bank.distribute(otherId, 104, address(0), 0.1 ether, block.timestamp + 20 minutes, REASON_BECAUSE, abi.encodePacked(r, s, v));
    }

    function testRejectsHighSSignature() public {
        vm.deal(address(bank), 1 ether);
        bytes32 id = keccak256("malleable");
        uint256 deadline = block.timestamp + 20 minutes;
        bytes memory signature = _sign(id, 104, address(0), 0.1 ether, deadline, keccak256("need"));
        bytes32 r;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            v := byte(0, mload(add(signature, 96)))
        }
        bytes32 highS = bytes32(uint256(0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) + 1);
        vm.expectRevert(ChogBank.BadSigner.selector);
        bank.distribute(id, 104, address(0), 0.1 ether, deadline, keccak256("need"), abi.encodePacked(r, highS, v));
    }

    function testRejectsBadAssetRecipientAndEmptyWallet() public {
        vm.deal(address(bank), 1 ether);
        bytes32 id = keccak256("asset");
        _expectAttempt(ChogBank.UnsupportedAsset.selector, bank, id, 104, makeAddr("other-token"), 0.1 ether);

        bytes32 missing = keccak256("missing-wallet");
        uint256 ghost = 999;
        assertEq(bank.citizenWallet(ghost).code.length, 0);
        _expectAttempt(ChogBank.WalletNotDeployed.selector, bank, missing, ghost, address(0), 0.1 ether);
        assertEq(address(bank).balance, 1 ether);
        assertFalse(bank.usedDecision(missing));
    }

    function testCapsInsufficientBalanceAndNextWindow() public {
        vm.deal(address(bank), 0.5 ether);
        _expectAttempt(ChogBank.InsufficientBalance.selector, bank, keccak256("poor"), 104, address(0), 1 ether);

        vm.deal(address(bank), 10 ether);
        _expectAttempt(ChogBank.PerTxCap.selector, bank, keccak256("big"), 104, address(0), 1 ether + 1);

        _attempt(bank, keccak256("first"), 104, address(0), 1 ether);
        _attempt(bank, keccak256("second"), 104, address(0), 1 ether);
        _expectAttempt(ChogBank.CitizenCap.selector, bank, keccak256("third"), 104, address(0), 1 wei);

        address wallet129 = factory.create(143, address(nft), 129);
        _attempt(bank, keccak256("other-citizen"), 129, address(0), 1 ether);
        assertEq(wallet129.balance, 1 ether);
        _expectAttempt(ChogBank.AggregateCap.selector, bank, keccak256("over-aggregate"), 129, address(0), 1 wei);

        vm.warp(block.timestamp + 1 days);
        _attempt(bank, keccak256("later"), 104, address(0), 1 ether);
        assertEq(wallet104.balance, 3 ether);
    }

    function testDeadlineBoundsAndZeroAmount() public {
        vm.deal(address(bank), 1 ether);
        bytes32 id = keccak256("ttl");
        uint256 far = block.timestamp + 1 hours + 1;
        _expectAttemptAt(ChogBank.DeadlineTooFar.selector, bank, id, 104, address(0), 0.1 ether, far, keccak256("x"));
        _expectAttemptAt(ChogBank.ZeroAmount.selector, bank, id, 104, address(0), 0, block.timestamp + 10 minutes, keccak256("x"));
        _expectAttemptAt(ChogBank.Replay.selector, bank, bytes32(0), 104, address(0), 0.1 ether, block.timestamp + 10 minutes, keccak256("x"));
    }

    function testNftTransferDoesNotRetargetTheWallet() public {
        vm.deal(address(bank), 1 ether);
        vm.prank(alice);
        nft.transfer(bob, 104);
        assertEq(nft.ownerOf(104), bob);
        bytes32 id = keccak256("after-transfer");
        uint256 deadline = block.timestamp + 15 minutes;
        bank.distribute(id, 104, address(0), 0.2 ether, deadline, keccak256("identity"), _sign(id, 104, address(0), 0.2 ether, deadline, keccak256("identity")));
        assertEq(wallet104.balance, 0.2 ether);
        assertEq(bob.balance, 0);
        assertEq(bank.citizenWallet(104), wallet104);

        vm.prank(bob);
        nft.transfer(alice, 104);
        assertEq(bank.citizenWallet(104), wallet104);
        assertEq(wallet104.balance, 0.2 ether);
    }

    function testWalletFormulaMatchesTheFactory() public view {
        assertEq(bank.citizenWallet(104), factory.predict(143, address(nft), 104));
        assertEq(bank.citizenWallet(129), factory.predict(143, address(nft), 129));
        assertEq(bank.citizenWallet(104), wallet104);
    }

    function testEip712FixtureDigest() public pure {
        assertEq(REASON_BECAUSE, keccak256("because"));
        ChogBank fixture = ChogBank(payable(address(0x1111111111111111111111111111111111111111)));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("chogOS ChogBank"),
                keccak256("1"),
                uint256(143),
                address(fixture)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Allocation(bytes32 decisionId,uint256 tokenId,address asset,uint256 amount,uint256 deadline,bytes32 reasonHash)"),
                bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
                uint256(104),
                address(0),
                uint256(1000),
                uint256(1700000000),
                REASON_BECAUSE
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), domain, structHash));
        assertEq(digest, EIP712_FIXTURE);
    }

    function testFalseAndShortTokenTransfersDoNotPay() public {
        FalseChog liar = new FalseChog();
        ChogBank liarBank = _bank(address(nft), address(liar), 1 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        bytes32 id = keccak256("liar");
        _expectAttempt(ChogBank.TransferFailed.selector, liarBank, id, 104, address(liar), 1 ether);
        assertFalse(liarBank.usedDecision(id));

        ShortChog shortToken = new ShortChog();
        ChogBank shortBank = _bank(address(nft), address(shortToken), 1 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        shortToken.mint(address(shortBank), 10 ether);
        _expectAttempt(ChogBank.TransferFailed.selector, shortBank, id, 104, address(shortToken), 4 ether);
        assertFalse(shortBank.usedDecision(id));
        assertEq(shortToken.balanceOf(wallet104), 0);
    }

    function testSilentErc20TransferStillPaysTheFullAmount() public {
        SilentChog silent = new SilentChog();
        ChogBank silentBank = _bank(address(nft), address(silent), 1 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        silent.mint(address(silentBank), 5 ether);
        bytes32 id = keccak256("silent");
        _attempt(silentBank, id, 104, address(silent), 2 ether);
        assertEq(silent.balanceOf(wallet104), 2 ether);
        assertTrue(silentBank.usedDecision(id));
    }

    function testReentrancyCannotApplyASecondDistribution() public {
        ReenterChog hostile = new ReenterChog();
        ChogBank hostileBank = _bank(address(nft), address(hostile), 1 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        address wallet129 = factory.create(143, address(nft), 129);
        hostile.mint(address(hostileBank), 20 ether);
        bytes32 second = keccak256("reenter-second");
        uint256 deadline = block.timestamp + 20 minutes;
        hostile.arm(hostileBank, second, 129, 1 ether, deadline, keccak256("second"));
        hostile.armSignature(_signFor(hostileBank, second, 129, address(hostile), 1 ether, deadline, keccak256("second")));
        _attemptAt(hostileBank, keccak256("reenter-first"), 104, address(hostile), 1 ether, deadline, keccak256("first"));
        assertTrue(hostileBank.usedDecision(keccak256("reenter-first")));
        assertFalse(hostileBank.usedDecision(second));
        assertEq(hostile.balanceOf(wallet104), 1 ether);
        assertEq(hostile.balanceOf(wallet129), 0);
        assertEq(hostile.attacks(), 1);
    }

    function testSequentialPayoutsAreAtomicWhenTheSecondExceedsTheCap() public {
        ChogBank wide = _bank(address(nft), address(chog), 2 ether, 2 ether, 3 ether, 10 ether, 20 ether, 30 ether);
        vm.deal(address(wide), 5 ether);
        bytes32 first = keccak256("batch-first");
        bytes32 second = keccak256("batch-second");
        uint256 deadline = block.timestamp + 20 minutes;
        vm.expectRevert(ChogBank.AggregateCap.selector);
        this.runBatch(wide, first, second, deadline);
        assertFalse(wide.usedDecision(first));
        assertEq(wallet104.balance, 0);
    }

    function runBatch(ChogBank wide, bytes32 first, bytes32 second, uint256 deadline) external {
        bytes memory firstSig = _signFor(wide, first, 104, address(0), 2 ether, deadline, keccak256("a"));
        bytes memory secondSig = _signFor(wide, second, 129, address(0), 2 ether, deadline, keccak256("b"));
        new TwoPayouts().run(wide, first, 104, second, 129, 2 ether, deadline, firstSig, secondSig);
    }

    function testNoAdminProxyOrFallback() public {
        assertEq(bank.configuredChainId(), 143);
        bytes32 implSlot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        bytes32 adminSlot = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
        assertEq(vm.load(address(bank), implSlot), bytes32(0));
        assertEq(vm.load(address(bank), adminSlot), bytes32(0));
        (bool ownerOk,) = address(bank).call(abi.encodeWithSignature("owner()"));
        (bool upgradeOk,) = address(bank).call(abi.encodeWithSignature("upgradeTo(address)", address(this)));
        (bool transferOk,) = address(bank).call(abi.encodeWithSignature("transferOwnership(address)", alice));
        (bool rescueOk,) = address(bank).call(abi.encodeWithSignature("emergencyWithdraw(address)", alice));
        (bool fallbackOk,) = address(bank).call(hex"deadbeef");
        assertFalse(ownerOk || upgradeOk || transferOk || rescueOk || fallbackOk);
    }

    function testConstructorGuards() public {
        vm.chainId(1);
        vm.expectRevert(ChogBank.WrongChain.selector);
        new ChogBank(_base(address(nft), address(chog)));

        vm.chainId(143);
        ChogBank.Init memory zeroCap = _base(address(nft), address(chog));
        zeroCap.maxPerTxMon = 0;
        vm.expectRevert(ChogBank.CapRequired.selector);
        new ChogBank(zeroCap);

        ChogBank.Init memory huge = _base(address(nft), address(chog));
        huge.maxPerTxMon = uint256(type(uint128).max) + 1;
        huge.maxCitizenWindowMon = huge.maxPerTxMon;
        huge.maxAggregateWindowMon = huge.maxPerTxMon;
        vm.expectRevert(ChogBank.CapTooLarge.selector);
        new ChogBank(huge);

        ChogBank.Init memory order = _base(address(nft), address(chog));
        order.maxPerTxMon = 3;
        order.maxCitizenWindowMon = 2;
        order.maxAggregateWindowMon = 2;
        vm.expectRevert(ChogBank.CapOrder.selector);
        new ChogBank(order);

        ChogBank.Init memory window = _base(address(nft), address(chog));
        window.windowSeconds = 1 minutes;
        window.maxAuthorizationTtl = 1 minutes;
        vm.expectRevert(ChogBank.BadWindow.selector);
        new ChogBank(window);

        ChogBank.Init memory ttl = _base(address(nft), address(chog));
        ttl.maxAuthorizationTtl = 1 minutes;
        vm.expectRevert(ChogBank.BadTtl.selector);
        new ChogBank(ttl);

        vm.expectRevert(ChogBank.CodeMissing.selector);
        new ChogBank(_base(makeAddr("empty-nft"), address(chog)));
    }

    function _bank(
        address genesis_,
        address chog_,
        uint256 perTxMon,
        uint256 citizenMon,
        uint256 aggregateMon,
        uint256 perTxChog,
        uint256 citizenChog,
        uint256 aggregateChog
    ) internal returns (ChogBank) {
        ChogBank.Init memory init = _base(genesis_, chog_);
        init.maxPerTxMon = perTxMon;
        init.maxCitizenWindowMon = citizenMon;
        init.maxAggregateWindowMon = aggregateMon;
        init.maxPerTxChog = perTxChog;
        init.maxCitizenWindowChog = citizenChog;
        init.maxAggregateWindowChog = aggregateChog;
        return new ChogBank(init);
    }

    function _base(address genesis_, address chog_) internal view returns (ChogBank.Init memory init) {
        init.genesis = genesis_;
        init.chogToken = chog_;
        init.walletFactory = address(factory);
        init.walletImplementation = address(implementation);
        init.authorizer = authorizer;
        init.windowSeconds = 1 days;
        init.maxAuthorizationTtl = 1 hours;
        init.maxPerTxMon = 1;
        init.maxCitizenWindowMon = 1;
        init.maxAggregateWindowMon = 1;
        init.maxPerTxChog = 1;
        init.maxCitizenWindowChog = 1;
        init.maxAggregateWindowChog = 1;
    }

    function _attempt(ChogBank target, bytes32 decisionId, uint256 tokenId, address asset, uint256 amount) internal {
        _attemptAt(target, decisionId, tokenId, asset, amount, block.timestamp + 20 minutes, keccak256("x"));
    }

    function _attemptAt(
        ChogBank target,
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reason
    ) internal {
        bytes memory signature = _signFor(target, decisionId, tokenId, asset, amount, deadline, reason);
        target.distribute(decisionId, tokenId, asset, amount, deadline, reason, signature);
    }

    function _expectAttempt(bytes4 selector, ChogBank target, bytes32 decisionId, uint256 tokenId, address asset, uint256 amount) internal {
        _expectAttemptAt(selector, target, decisionId, tokenId, asset, amount, block.timestamp + 20 minutes, keccak256("x"));
    }

    function _expectAttemptAt(
        bytes4 selector,
        ChogBank target,
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reason
    ) internal {
        bytes memory signature = _signFor(target, decisionId, tokenId, asset, amount, deadline, reason);
        vm.expectRevert(selector);
        target.distribute(decisionId, tokenId, asset, amount, deadline, reason, signature);
    }

    function _sign(bytes32 decisionId, uint256 tokenId, address asset, uint256 amount, uint256 deadline, bytes32 reason)
        internal
        view
        returns (bytes memory)
    {
        return _signFor(bank, decisionId, tokenId, asset, amount, deadline, reason);
    }

    function _signFor(
        ChogBank target,
        bytes32 decisionId,
        uint256 tokenId,
        address asset,
        uint256 amount,
        uint256 deadline,
        bytes32 reason
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AUTHORIZER_KEY, target.allocationDigest(decisionId, tokenId, asset, amount, deadline, reason));
        return abi.encodePacked(r, s, v);
    }

    function _foreignDigest(bytes32 decisionId) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("chogOS ChogBank"),
                keccak256("1"),
                uint256(1),
                address(0x1111111111111111111111111111111111111111)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Allocation(bytes32 decisionId,uint256 tokenId,address asset,uint256 amount,uint256 deadline,bytes32 reasonHash)"),
                decisionId,
                uint256(104),
                address(0),
                uint256(0.1 ether),
                uint256(0),
                REASON_BECAUSE
            )
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), domain, structHash));
    }
}

contract TwoPayouts {
    function run(
        ChogBank bank,
        bytes32 first,
        uint256 firstToken,
        bytes32 second,
        uint256 secondToken,
        uint256 amount,
        uint256 deadline,
        bytes calldata firstSig,
        bytes calldata secondSig
    ) external {
        bank.distribute(first, firstToken, address(0), amount, deadline, keccak256("a"), firstSig);
        bank.distribute(second, secondToken, address(0), amount, deadline, keccak256("b"), secondSig);
    }
}

contract ChogBankScriptTest is Test {
    function testDeploymentGatesStayClosedUntilEachPhraseAndTheWalletPath() public {
        DeployChogBank bankScript = new DeployChogBank();
        vm.chainId(1);
        vm.setEnv("CHOG_BANK_AUTHORIZE_BROADCAST", "yes-deploy-chogbank-on-monad-mainnet");
        vm.expectRevert(DeployChogBank.WrongChain.selector);
        bankScript.run();

        vm.chainId(143);
        vm.setEnv("CHOG_BANK_AUTHORIZE_BROADCAST", "disabled");
        vm.expectRevert(DeployChogBank.BroadcastDisabled.selector);
        bankScript.run();

        vm.setEnv("CHOG_BANK_AUTHORIZE_WALLETS", "no");
        vm.setEnv("CHOG_BANK_AUTHORIZE_PAYOUT", "no");
        DeployCitizenWallets wallets = new DeployCitizenWallets();
        vm.expectRevert(DeployCitizenWallets.BroadcastDisabled.selector);
        wallets.run();
        ChogBankPayout payout = new ChogBankPayout();
        vm.expectRevert(ChogBankPayout.BroadcastDisabled.selector);
        payout.run();

        vm.setEnv("CHOG_BANK_AUTHORIZE_BROADCAST", "yes-deploy-chogbank-on-monad-mainnet");
        vm.setEnv("CHOG_BANK_AUTHORIZER", "0x0000000000000000000000000000000000000001");
        vm.setEnv("CHOG_BANK_WINDOW_SECONDS", "86400");
        vm.setEnv("CHOG_BANK_MAX_AUTHORIZATION_TTL", "3600");
        vm.setEnv("CHOG_BANK_MAX_PER_TX_MON", "100000000000000000");
        vm.setEnv("CHOG_BANK_MAX_CITIZEN_WINDOW_MON", "1000000000000000000");
        vm.setEnv("CHOG_BANK_MAX_AGGREGATE_WINDOW_MON", "2000000000000000000");
        vm.setEnv("CHOG_BANK_MAX_PER_TX_CHOG", "1");
        vm.setEnv("CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG", "1");
        vm.setEnv("CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG", "1");
        vm.expectRevert(DeployChogBank.CodeMissing.selector);
        bankScript.run();

        vm.etch(0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763, hex"00");
        vm.etch(0x350035555E10d9AfAF1566AaebfCeD5BA6C27777, hex"00");
        vm.expectRevert(DeployChogBank.WalletPathMissing.selector);
        bankScript.run();

        vm.setEnv("CHOG_BANK_AUTHORIZE_WALLETS", "yes-deploy-citizen-wallets-on-monad-mainnet");
        vm.setEnv("CHOG_BANK_DEMO_TOKEN_ID", "104");
        address deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        if (deployer.code.length == 0) {
            vm.etch(
                deployer,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        address wallet = wallets.run();
        assertGt(wallet.code.length, 0);
        assertEq(wallet, new DeployCitizenAccountFactoryV2().predictAccount(143, 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763, 104));
    }
}

contract ChogBankForkTest is Test {
    function testOfficialChogDecimalsOnMonad() public {
        try this.readOfficialChogDecimals() returns (uint8 decimals) {
            assertEq(decimals, 18);
            assertEq(block.chainid, 143);
        } catch {
            vm.skip(true);
        }
    }

    function readOfficialChogDecimals() external returns (uint8) {
        string memory rpc = vm.envString("MONAD_RPC_URL");
        vm.createSelectFork(rpc);
        address chog = 0x350035555E10d9AfAF1566AaebfCeD5BA6C27777;
        address genesis = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
        require(chog.code.length > 0 && genesis.code.length > 0, "official code missing");
        (bool ok, bytes memory data) = chog.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "decimals call failed");
        return abi.decode(data, (uint8));
    }
}
