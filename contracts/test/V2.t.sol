// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {MockPool} from "./mocks/Mocks.sol";

/// @notice v2 features: k-of-n committee, permissionless TWAP stop-loss / take-profit with
///         re-entry lockout, NAV drawdown breaker, committee-signed expected-value floor.
contract V2Test is BaseTest {
    uint256 riskOfficerPk = 0x415C;
    address riskOfficer;
    CountersignVault v2;

    function setUp() public override {
        super.setUp();
        riskOfficer = vm.addr(riskOfficerPk);
        address[] memory assets = vault.assets();
        uint24[] memory fees = new uint24[](2);
        fees[0] = FEE;
        fees[1] = FEE;
        address[] memory committee = new address[](2);
        committee[0] = guardian;
        committee[1] = riskOfficer;
        CountersignVault.Mandate memory m = defaultMandate();
        m.stopLossBps = 300; // -3%
        m.takeProfitBps = 500; // +5%
        m.maxDrawdownBps = 1000; // -10% NAV
        vm.prank(owner);
        v2 = CountersignVault(factory.createVault(agent, committee, 2, address(usdt), assets, fees, m));
        usdt.mint(address(v2), 500e6);
    }

    // ------------------------------------------------------------- helpers

    function sigOf(CountersignVault.ExecutionPermit memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, v2.permitDigest(p));
        return abi.encodePacked(r, s, v);
    }

    /// @dev signatures ordered by signer address, as the vault requires
    function both(CountersignVault.ExecutionPermit memory p) internal view returns (bytes[] memory a) {
        a = new bytes[](2);
        (uint256 lo, uint256 hi) = guardian < riskOfficer ? (guardianPk, riskOfficerPk) : (riskOfficerPk, guardianPk);
        a[0] = sigOf(p, lo);
        a[1] = sigOf(p, hi);
    }

    function buyP(address asset, uint256 amountIn)
        internal
        returns (bytes memory path, CountersignVault.ExecutionPermit memory p)
    {
        path = path1(address(usdt), asset);
        uint256 q = router.quoteHop(address(usdt), asset, FEE, amountIn);
        p = permit(path, 2, amountIn, q * 9990 / 10_000, q * 9900 / 10_000, bytes32(0));
        p.policyHash = v2.policyHash();
    }

    function buy2(address asset, uint256 amountIn) internal returns (uint256) {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(asset, amountIn);
        bytes[] memory s = both(p);
        vm.prank(agent);
        return v2.execute(path, p, s);
    }

    function shift(MockPool pool, address base, int24 deltaTicks) internal {
        int24 t = pool.tick();
        pool.setTick(pool.token0() == base ? t + deltaTicks : t - deltaTicks);
    }

    // ============================================================ committee

    function test_Committee_TwoOfTwoExecutes() public {
        uint256 out = buy2(address(whsk), 10e6);
        assertGt(out, 0);
        assertEq(v2.threshold(), 2);
        assertEq(v2.guardians().length, 2);
    }

    function test_Committee_RiskOfficerVeto_OneSignatureIsNotEnough() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        bytes[] memory s = new bytes[](1);
        s[0] = sigOf(p, guardianPk); // the Execution Guardian approves, the Risk Officer does not
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.NotEnoughSignatures.selector, 1, 2));
        v2.execute(path, p, s);
    }

    function test_Committee_SameSignatureTwiceRejected() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        bytes[] memory s = new bytes[](2);
        s[0] = sigOf(p, guardianPk);
        s[1] = s[0];
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        v2.execute(path, p, s);
    }

    function test_Committee_UnsortedRejected() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        bytes[] memory s = both(p);
        (s[0], s[1]) = (s[1], s[0]);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        v2.execute(path, p, s);
    }

    function test_Committee_OutsiderCannotFillASeat() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        // stolen agent key + one real guardian: still refused
        bytes[] memory s = new bytes[](2);
        (uint256 lo, uint256 hi) = guardian < agent ? (guardianPk, agentPk) : (agentPk, guardianPk);
        s[0] = sigOf(p, lo);
        s[1] = sigOf(p, hi);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        v2.execute(path, p, s);
    }

    function test_SetCommittee_Bounds() public {
        address[] memory g = new address[](2);
        g[0] = guardian;
        g[1] = riskOfficer;
        vm.startPrank(owner);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        v2.setCommittee(g, 0);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        v2.setCommittee(g, 3);
        g[1] = guardian;
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        v2.setCommittee(g, 1); // duplicate member
        g[1] = owner;
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        v2.setCommittee(g, 1); // owner cannot sit on the committee
        g[1] = agent;
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        v2.setCommittee(g, 1); // nor can the agent
        vm.stopPrank();
        vm.prank(guardian);
        vm.expectRevert(CountersignVault.NotOwner.selector);
        v2.setCommittee(g, 1);
    }

    // ===================================================== expected value floor

    function test_ExpectedLossIsRefused() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        p.expectedNetValue = 0;
        bytes[] memory s = both(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ExpectedLoss.selector, int256(0), uint256(0)));
        v2.execute(path, p, s);

        p.expectedNetValue = -5_000;
        s = both(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ExpectedLoss.selector, int256(-5_000), uint256(0)));
        v2.execute(path, p, s);
    }

    function test_ExpectedValueFloorFromMandate() public {
        CountersignVault.Mandate memory m = v2.mandate();
        m.minNetValueQuote = 20_000; // 0.02 USDT
        vm.prank(agent);
        v2.tighten(m);
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        p.expectedNetValue = 19_999;
        bytes[] memory s = both(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ExpectedLoss.selector, int256(19_999), uint256(20_000)));
        v2.execute(path, p, s);
    }

    // ============================================== permissionless stop-loss

    function test_StopLoss_AnyoneCanFireIt_AndReentryIsLocked() public {
        uint256 got = buy2(address(whsk), 50e6);
        shift(whskUsdt, address(whsk), -513); // ~ -5% on the TWAP
        (,, bool stopNow,) = v2.stopStatus(address(whsk));
        assertTrue(stopNow);

        address stranger = makeAddr("keeper");
        vm.prank(stranger);
        uint256 out = v2.stopOut(address(whsk), got, 0);
        assertGt(out, 0);
        (uint128 qty,) = v2.positions(address(whsk));
        assertEq(qty, 0);
        (, int128 pnl) = v2.currentDay();
        assertLt(pnl, 0);

        vm.warp(vm.getBlockTimestamp() + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 10e6);
        bytes[] memory s = both(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ReentryLocked.selector, block.timestamp - 61 + 1 hours));
        v2.execute(path, p, s);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        buy2(address(whsk), 10e6); // lockout over
    }

    function test_StopLoss_NotTriggeredInsideTheBand() public {
        uint256 got = buy2(address(whsk), 50e6);
        shift(whskUsdt, address(whsk), -100); // ~ -1%
        vm.expectRevert();
        v2.stopOut(address(whsk), got, 0);
    }

    function test_StopLoss_WorksWithAgentRevokedAndVaultPaused() public {
        uint256 got = buy2(address(whsk), 50e6);
        vm.startPrank(owner);
        v2.pause();
        v2.setAgent(address(0));
        vm.stopPrank();
        shift(whskUsdt, address(whsk), -513);
        v2.stopOut(address(whsk), got, 0); // nobody on the trading side is needed
        (uint128 qty,) = v2.positions(address(whsk));
        assertEq(qty, 0);
    }

    function test_StopLoss_CannotBeSandwiched_TwapAnchoredFloor() public {
        uint256 got = buy2(address(whsk), 50e6);
        shift(whskUsdt, address(whsk), -513);
        // the execution price is 4% worse than the TWAP (a sandwich / wick): the floor refuses it
        router.setDeviation(address(whskUsdt), -400);
        vm.expectRevert(bytes("Too little received"));
        v2.stopOut(address(whsk), got, 0);
    }

    function test_StopLoss_PartialExitsForThinPools() public {
        uint256 got = buy2(address(whsk), 50e6);
        shift(whskUsdt, address(whsk), -513);
        v2.stopOut(address(whsk), got / 2, 0);
        (uint128 qty, uint128 cost) = v2.positions(address(whsk));
        assertEq(qty, got - got / 2);
        assertApproxEqAbs(cost, 25e6, 1);
        v2.stopOut(address(whsk), qty, 0);
    }

    function test_TakeProfit_AnyoneCanFireIt() public {
        uint256 got = buy2(address(whsk), 50e6);
        shift(whskUsdt, address(whsk), 700); // ~ +7%
        (,,, bool tp) = v2.stopStatus(address(whsk));
        assertTrue(tp);
        v2.stopOut(address(whsk), got, 0);
        (, int128 pnl) = v2.currentDay();
        assertGt(pnl, 0);
        // a take-profit does not lock re-entry
        vm.warp(vm.getBlockTimestamp() + 61);
        buy2(address(whsk), 10e6);
    }

    function test_StopOut_UntrackedOrUnknownRefused() public {
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.NotEnoughTracked.selector, 1, 0));
        v2.stopOut(address(whsk), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.UnknownToken.selector, address(0xdead)));
        v2.stopOut(address(0xdead), 1, 0);
    }

    // ============================================================ breaker

    function _concentrate() internal returns (uint256 a, uint256 b) {
        vm.prank(owner);
        v2.withdraw(address(usdt), 400e6); // NAV ~100 USDT
        a = buy2(address(whsk), 50e6);
        vm.warp(vm.getBlockTimestamp() + 61);
        b = buy2(address(whsk), 45e6);
        v2.checkBreaker(); // sets the high-water mark
    }

    function test_Breaker_BlocksEntriesOnDrawdown_ExitsStillWork() public {
        CountersignVault.Mandate memory m = v2.mandate();
        m.stopLossBps = 0; // isolate the breaker from the per-position stop
        vm.prank(owner);
        v2.setMandate(m);
        (uint256 a, uint256 b) = _concentrate();
        uint256 hwm = v2.highWaterMark();
        assertGt(hwm, 98e6);

        shift(whskUsdt, address(whsk), -1625); // ~ -15% on the whole vault
        vm.warp(vm.getBlockTimestamp() + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p) = buyP(address(whsk), 1e6);
        bytes[] memory s = both(p);
        vm.prank(agent);
        vm.expectPartialRevert(CountersignVault.DrawdownBreaker.selector);
        v2.execute(path, p, s); // refused even before anyone calls checkBreaker()

        vm.prank(makeAddr("anyone"));
        (, bool tripped) = v2.checkBreaker();
        assertTrue(tripped);

        // exits are never blocked: sell everything through a committee-signed EXIT
        bytes memory sp = path1(address(whsk), address(usdt));
        uint256 q = router.quoteHop(address(whsk), address(usdt), FEE, a + b);
        CountersignVault.ExecutionPermit memory xp = permit(sp, 0, a + b, q * 999 / 1000, 0, bytes32(0));
        xp.policyHash = v2.policyHash();
        s = both(xp);
        vm.prank(agent);
        v2.execute(sp, xp, s);

        vm.prank(owner);
        v2.resetBreaker();
        assertFalse(v2.breakerTripped());
    }

    function test_Breaker_WithdrawalIsNotADrawdown() public {
        buy2(address(whsk), 50e6);
        v2.checkBreaker();
        uint256 hwm = v2.highWaterMark();
        vm.prank(owner);
        v2.withdraw(address(usdt), 300e6);
        assertLt(v2.highWaterMark(), hwm);
        vm.warp(vm.getBlockTimestamp() + 61);
        buy2(address(weth), 10e6); // not blocked by the breaker
        (, bool tripped) = v2.checkBreaker();
        assertFalse(tripped);
    }

    function test_NavCountsCashAndPositionsAtTwap() public {
        uint256 n0 = v2.nav();
        assertEq(n0, 500e6);
        buy2(address(whsk), 50e6);
        uint256 n1 = v2.nav();
        assertApproxEqRel(n1, 500e6, 0.005e18); // only the 0.3% pool fee is lost
    }

    // ============================================================ tighten v2

    function test_Tighten_StopAndBreakerRules() public {
        CountersignVault.Mandate memory c = v2.mandate();
        CountersignVault.Mandate memory m = v2.mandate();
        m.stopLossBps = 200;
        m.maxDrawdownBps = 500;
        m.minNetValueQuote = 1;
        vm.prank(agent);
        v2.tighten(m); // all stricter

        m = v2.mandate();
        m.stopLossBps = 0; // turning a stop OFF is looser
        vm.prank(agent);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        v2.tighten(m);

        m = v2.mandate();
        m.maxDrawdownBps = c.maxDrawdownBps; // back up to 1000: looser
        vm.prank(guardian);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        v2.tighten(m);

        m = v2.mandate();
        m.minNetValueQuote = 0;
        vm.prank(riskOfficer);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        v2.tighten(m);
    }

    function test_AnyCommitteeMemberCanPause_OnlyOwnerUnpauses() public {
        vm.prank(riskOfficer);
        v2.pause();
        assertTrue(v2.paused());
        vm.prank(riskOfficer);
        vm.expectRevert(CountersignVault.NotOwner.selector);
        v2.unpause();
    }
}
