// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {ECDSALite} from "../src/libraries/Utils.sol";
import {MockPool, ReentrantRouter} from "./mocks/Mocks.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

contract CountersignVaultTest is BaseTest {
    // =========================================================== setup / init

    function test_InitState() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.quote(), address(usdt));
        assertEq(vault.assets().length, 2);
        assertEq(vault.policyNonce(), 1);
        assertTrue(vault.policyHash() != bytes32(0));
        assertTrue(factory.isVault(address(vault)));
        assertEq(factory.vaultsOf(owner)[0], address(vault));
    }

    function test_ImplementationCannotBeInitialized() public {
        CountersignVault.InitParams memory p;
        vm.expectRevert(CountersignVault.AlreadyInitialized.selector);
        impl.initialize(p);
    }

    function test_CloneCannotBeReinitialized() public {
        CountersignVault.InitParams memory p;
        vm.expectRevert(CountersignVault.AlreadyInitialized.selector);
        vault.initialize(p);
    }

    function test_RolesMustBeDistinct() public {
        address[] memory assets = new address[](1);
        assets[0] = address(whsk);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        vm.prank(owner);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        address[] memory g = new address[](1);
        g[0] = agent; // the agent cannot also be a guardian
        factory.createVault(agent, g, 1, address(usdt), assets, fees, defaultMandate());
    }

    // =============================================================== BUY path

    function test_Buy_TierB_HappyPath() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 50e6);
        vm.expectEmit(true, true, false, false, address(vault));
        emit CountersignVault.TradeExecuted(
            p.tradeId, 2, 1, address(usdt), address(whsk), 50e6, 0, 0, 0, 0, bytes32(0), bytes32(0)
        );
        vm.prank(agent);
        uint256 out = vault.execute(path, p, sig);

        assertGt(out, 600e18); // ~0.08 USDT/WHSK -> ~623 WHSK for 50 USDT
        assertEq(whsk.balanceOf(address(vault)), out);
        assertEq(usdt.balanceOf(address(vault)), 450e6);
        (uint128 qty, uint128 cost) = vault.positions(address(whsk));
        assertEq(qty, out);
        assertEq(cost, 50e6);
        (uint128 vol, int128 pnl) = vault.currentDay();
        assertEq(vol, 50e6);
        assertEq(pnl, 0);
        assertTrue(vault.usedTradeIds(p.tradeId));
        assertEq(usdt.allowance(address(vault), address(router)), 0, "approval reset");
    }

    function test_Buy_TierC_RequiresPrediction() public {
        bytes memory path = path1(address(usdt), address(whsk));
        uint256 q = router.quoteHop(address(usdt), address(whsk), FEE, 10e6);
        CountersignVault.ExecutionPermit memory p = permit(path, 3, 10e6, q * 999 / 1000, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.MissingPrediction.selector);
        vault.execute(path, p, sig);

        p = permit(path, 3, 10e6, q * 999 / 1000, 0, keccak256("ETH>2550 before T, void <2420, p=0.7"));
        sig = sign(p, guardianPk);
        vm.prank(agent);
        vault.execute(path, p, sig);
    }

    // ============================================== two-key: the AI can't trade alone

    function test_Attack_StolenAgentKey_SelfSignedPermit() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p,) = buyPermit(address(whsk), 50e6);
        bytes[] memory forged = sign(p, agentPk); // the agent signs its own permit
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, forged);
    }

    function test_Attack_AttackerSignedPermit() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p,) = buyPermit(address(whsk), 50e6);
        bytes[] memory forged = sign(p, attackerPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, forged);
    }

    function test_Attack_GuardianCannotSubmit() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 50e6);
        vm.prank(guardian);
        vm.expectRevert(CountersignVault.NotAgent.selector);
        vault.execute(path, p, sig);
    }

    function test_Attack_OwnerCannotSubmitAsAgent() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 50e6);
        vm.prank(owner);
        vm.expectRevert(CountersignVault.NotAgent.selector);
        vault.execute(path, p, sig);
    }

    function test_Attack_TamperedAmount() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        p.amountIn = 50e6; // AI tries to upsize after approval
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, sig);
    }

    function test_Attack_TamperedMinOut() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        p.minOut = 1;
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, sig);
    }

    function test_Attack_TamperedPath() public {
        (, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) = buyPermit(address(whsk), 10e6);
        bytes memory other = path1(address(usdt), address(weth));
        vm.prank(agent);
        vm.expectRevert(CountersignVault.PathMismatch.selector);
        vault.execute(other, p, sig);
    }

    function test_Attack_ReplayTradeId() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.prank(agent);
        vault.execute(path, p, sig);
        vm.warp(block.timestamp + 61);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.TradeIdUsed.selector);
        vault.execute(path, p, sig);
    }

    function test_Attack_PermitForOtherVaultRejected() public {
        // Same owner, second vault: a permit signed for vault #1 must not work on vault #2.
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        address[] memory assets = vault.assets();
        uint24[] memory fees = new uint24[](2);
        fees[0] = FEE;
        fees[1] = FEE;
        vm.prank(owner);
        CountersignVault v2 = CountersignVault(
            factory.createVault(agent, committee1(), 1, address(usdt), assets, fees, defaultMandate())
        );
        usdt.mint(address(v2), 100e6);
        p.policyHash = v2.policyHash(); // even with a matching policy hash, the domain differs
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        v2.execute(path, p, sig);
    }

    function test_Attack_MalleableSignatureRejected() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        bytes memory raw = sig[0];
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(raw, 32))
            s := mload(add(raw, 64))
            v := byte(0, mload(add(raw, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(agent);
        vm.expectRevert(ECDSALite.InvalidSignature.selector);
        vault.execute(path, p, one(flipped));
    }

    function test_Attack_ReentrancyViaRouter() public {
        ReentrantRouter evil = new ReentrantRouter();
        CountersignVault evilImpl = new CountersignVault(address(evil), address(pf));
        CountersignVault v = _cloneOf(address(evilImpl));
        usdt.mint(address(v), 100e6);

        bytes memory path = path1(address(usdt), address(whsk));
        uint256 q = router.quoteHop(address(usdt), address(whsk), FEE, 10e6);
        CountersignVault.ExecutionPermit memory p = _permitFor(v, path, 2, 10e6, q * 999 / 1000, q * 99 / 100);
        bytes[] memory sig = _signFor(v, p);
        // the router re-enters execute() during the swap
        evil.arm(address(v), abi.encodeCall(CountersignVault.execute, (path, p, sig)));
        vm.prank(agent);
        vm.expectRevert(CountersignVault.Reentrancy.selector);
        v.execute(path, p, sig);
    }

    // ======================================================== mandate checks

    function test_Revert_PermitExpired() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.warp(p.deadline + 1);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.PermitExpired.selector);
        vault.execute(path, p, sig);
    }

    function test_Revert_MandateExpired() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        p.deadline = uint64(block.timestamp + 8 days);
        sig = sign(p, guardianPk);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.MandateExpired.selector);
        vault.execute(path, p, sig);
    }

    function test_Revert_PolicyChangeInvalidatesPermits() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        CountersignVault.Mandate memory m = vault.mandate();
        m.maxTradeQuote = 40e6;
        vm.prank(owner);
        vault.setMandate(m);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.PolicyMismatch.selector);
        vault.execute(path, p, sig);
    }

    function test_Revert_TradeTooLarge() public {
        // Scenario 5: the AI asks for 100 USDT when the cap is 50 — even with a Guardian signature.
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 100e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.TradeTooLarge.selector, 100e6, 50e6));
        vault.execute(path, p, sig);
    }

    function test_Revert_DailyVolume() public {
        doBuy(address(whsk), 50e6);
        vm.warp(block.timestamp + 61);
        doBuy(address(weth), 50e6);
        vm.warp(block.timestamp + 61);
        doBuy(address(whsk), 50e6);
        vm.warp(block.timestamp + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(weth), 1e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.DailyVolumeExceeded.selector, 151e6, 150e6));
        vault.execute(path, p, sig);
    }

    function test_Revert_Exposure() public {
        doBuy(address(whsk), 50e6);
        vm.warp(block.timestamp + 61);
        doBuy(address(whsk), 50e6);
        vm.warp(block.timestamp + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 1e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ExposureExceeded.selector, 101e6, 100e6));
        vault.execute(path, p, sig);
    }

    function test_Revert_Cooldown() public {
        doBuy(address(whsk), 10e6);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(weth), 10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.Cooldown.selector, block.timestamp + 60));
        vault.execute(path, p, sig);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        vault.execute(path, p, sig);
    }

    function test_Revert_BelowTwapFloor() public {
        // Scenario 3-style: a Guardian (bug) approves a floor far below the TWAP. The vault refuses.
        bytes memory path = path1(address(usdt), address(whsk));
        uint256 q = router.quoteHop(address(usdt), address(whsk), FEE, 10e6);
        CountersignVault.ExecutionPermit memory p = permit(path, 3, 10e6, q / 2, 0, keccak256("p"));
        bytes[] memory sig = sign(p, guardianPk);
        uint256 floor = vault.twapFloor(address(usdt), address(whsk), FEE, 10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.BelowTwapFloor.selector, q / 2, floor));
        vault.execute(path, p, sig);
    }

    function test_Revert_RouterMinOutWhenMarketMoves() public {
        // Scenario 3: quote validated, then the market moves against us before inclusion.
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        router.setDeviation(address(whskUsdt), -300); // execution 3% worse than TWAP
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.execute(path, p, sig);
    }

    function test_Revert_InsufficientEdge() public {
        bytes memory path = path1(address(usdt), address(whsk));
        uint256 q = router.quoteHop(address(usdt), address(whsk), FEE, 10e6);
        // reference equals the pool: no edge at all
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 10e6, q * 999 / 1000, q, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        uint256 required = (q * 10_050 + 9_999) / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.InsufficientEdge.selector, q * 999 / 1000, required));
        vault.execute(path, p, sig);
    }

    function test_Revert_TierDisabled() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.tiersMask = 1; // risk appetite "low": arbitrage only
        vm.prank(owner);
        vault.setMandate(m);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.TierNotAllowed.selector, 2));
        vault.execute(path, p, sig);
    }

    function test_Revert_ExitTierCannotBuy() public {
        bytes memory path = path1(address(usdt), address(whsk));
        uint256 q = router.quoteHop(address(usdt), address(whsk), FEE, 10e6);
        CountersignVault.ExecutionPermit memory p = permit(path, 0, 10e6, q * 999 / 1000, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.TierNotAllowed.selector, 0));
        vault.execute(path, p, sig);
    }

    function test_Revert_AssetNotAllowed() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.assetsMask = 1; // "only trade WHSK"
        vm.prank(owner);
        vault.setMandate(m);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(weth), 10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.AssetNotAllowed.selector, address(weth)));
        vault.execute(path, p, sig);
    }

    function test_Revert_UnknownToken() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(0xdead));
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 10e6, 1, 1, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.UnknownToken.selector, address(0xdead)));
        vault.execute(path, p, sig);
    }

    function test_Revert_UnsupportedRoute_AssetToAsset() public {
        bytes memory path = path1(address(whsk), address(weth));
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 1e18, 1, 1, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.UnsupportedRoute.selector);
        vault.execute(path, p, sig);
    }

    function test_Revert_MultiHopBuyNotAllowed() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(weth), FEE, address(whsk));
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 1e6, 1, 1, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.UnsupportedRoute.selector);
        vault.execute(path, p, sig);
    }

    function test_Revert_BadPath() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE);
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 1e6, 1, 1, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.BadPath.selector);
        vault.execute(path, p, sig);
    }

    // ============================================================ SELL / exits

    function test_Sell_RealizesProfit() public {
        uint256 bought = doBuy(address(whsk), 50e6);
        _shiftPrice(whskUsdt, address(whsk), 488); // ~ +5%
        vm.warp(block.timestamp + 61);
        uint256 out = doSell(address(whsk), bought, 2);
        (uint128 qty, uint128 cost) = vault.positions(address(whsk));
        assertEq(qty, 0);
        assertEq(cost, 0);
        (, int128 pnl) = vault.currentDay();
        assertEq(pnl, int128(int256(out) - 50e6));
        assertGt(pnl, 0);
    }

    function test_Sell_PartialKeepsAverageCost() public {
        uint256 bought = doBuy(address(whsk), 40e6);
        doSell(address(whsk), bought / 4, 0);
        (uint128 qty, uint128 cost) = vault.positions(address(whsk));
        assertEq(qty, bought - bought / 4);
        assertEq(cost, 40e6 - (uint256(40e6) * (bought / 4)) / bought);
    }

    function test_Revert_SellMoreThanTracked() public {
        uint256 bought = doBuy(address(whsk), 10e6);
        whsk.mint(address(vault), 1e18); // untracked donation
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            sellPermit(address(whsk), bought + 1, 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.NotEnoughTracked.selector, bought + 1, bought));
        vault.execute(path, p, sig);
    }

    function test_ExitAllowedWhilePaused_EntriesBlocked() public {
        uint256 bought = doBuy(address(whsk), 20e6);
        vm.prank(owner);
        vault.pause();
        vm.warp(block.timestamp + 61);

        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(weth), 10e6);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.VaultPaused.selector);
        vault.execute(path, p, sig);

        doSell(address(whsk), bought, 0); // the stop-loss is never trapped
        (uint128 qty,) = vault.positions(address(whsk));
        assertEq(qty, 0);
    }

    function test_DailyLoss_BlocksEntries_AllowsExits_ResetsNextDay() public {
        // Scenario 6
        uint256 b1 = doBuy(address(whsk), 50e6);
        vm.warp(block.timestamp + 61);
        uint256 b2 = doBuy(address(weth), 30e6);
        _shiftPrice(whskUsdt, address(whsk), -3567); // ~ -30%
        doSell(address(whsk), b1, 0);
        (, int128 pnl) = vault.currentDay();
        assertLt(pnl, -10e6);

        vm.warp(block.timestamp + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(weth), 1e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.DailyLossReached.selector, pnl, 10e6));
        vault.execute(path, p, sig);

        doSell(address(weth), b2, 0); // exits still work

        vm.warp((block.timestamp / 1 days + 1) * 1 days + 1); // next UTC day
        (bytes memory path2, CountersignVault.ExecutionPermit memory p2, bytes[] memory sig2) =
            buyPermit(address(weth), 1e6);
        vm.prank(agent);
        vault.execute(path2, p2, sig2);
        (uint128 vol, int128 pnl2) = vault.currentDay();
        assertEq(vol, 1e6);
        assertEq(pnl2, 0);
    }

    function test_DailyLossCapZero_AllowsEntriesUntilFirstLoss() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.dailyLossQuote = 0;
        vm.prank(agent);
        vault.tighten(m); // "never lose money today"
        uint256 bought = doBuy(address(whsk), 10e6); // pnl == 0 -> entry allowed
        doSell(address(whsk), bought, 0); // round trip loses the pool fees
        (, int128 pnl) = vault.currentDay();
        assertLt(pnl, 0);
        vm.warp(block.timestamp + 61);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 1e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.DailyLossReached.selector, pnl, 0));
        vault.execute(path, p, sig);
    }

    // =========================================================== Tier A arbitrage

    function test_Arb_ProfitOrRevert_Profitable() public {
        router.setDeviation(address(whskWeth), 200); // a 2% dislocation on the cross pool
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(whsk), FEE, address(weth), FEE, address(usdt));
        uint256 out = _quotePath3(10e6);
        assertGt(out, 10e6);
        CountersignVault.ExecutionPermit memory p = permit(path, 1, 10e6, out, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        uint256 before = usdt.balanceOf(address(vault));
        vm.prank(agent);
        vault.execute(path, p, sig);
        assertEq(usdt.balanceOf(address(vault)), before - 10e6 + out);
        (, int128 pnl) = vault.currentDay();
        assertEq(pnl, int128(int256(out) - 10e6));
    }

    function test_Arb_ProfitOrRevert_RevertsWhenGapCloses() public {
        router.setDeviation(address(whskWeth), 200);
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(whsk), FEE, address(weth), FEE, address(usdt));
        uint256 out = _quotePath3(10e6);
        CountersignVault.ExecutionPermit memory p = permit(path, 1, 10e6, out, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        router.setDeviation(address(whskWeth), 0); // someone else closes the gap first
        uint256 before = usdt.balanceOf(address(vault));
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.execute(path, p, sig);
        assertEq(usdt.balanceOf(address(vault)), before, "principal untouched");
    }

    function test_Arb_MinOutMustLockProfit() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(whsk), FEE, address(weth), FEE, address(usdt));
        CountersignVault.ExecutionPermit memory p = permit(path, 1, 10e6, 10e6, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.ArbProfitTooLow.selector, 10e6, 10.01e6));
        vault.execute(path, p, sig);
    }

    function test_Arb_WrongTier() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(whsk), FEE, address(weth), FEE, address(usdt));
        CountersignVault.ExecutionPermit memory p = permit(path, 2, 10e6, 11e6, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.TierNotAllowed.selector, 2));
        vault.execute(path, p, sig);
    }

    function test_Arb_QuoteAsIntermediateRejected() public {
        bytes memory path = abi.encodePacked(address(usdt), FEE, address(whsk), FEE, address(usdt), FEE, address(usdt));
        CountersignVault.ExecutionPermit memory p = permit(path, 1, 10e6, 11e6, 0, bytes32(0));
        bytes[] memory sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.AssetNotAllowed.selector, address(usdt)));
        vault.execute(path, p, sig);
    }

    // ========================================================= owner controls

    function test_RevokeAgent() public {
        // Scenario 8
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.prank(owner);
        vault.setAgent(address(0));
        vm.prank(agent);
        vm.expectRevert(CountersignVault.NotAgent.selector);
        vault.execute(path, p, sig);
    }

    function test_GuardianRotationInvalidatesOldPermits() public {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.prank(owner);
        vault.setCommittee(committeeOf(vm.addr(0x9999)), 1);
        // the committee is part of the policy: every outstanding permit dies at once
        vm.prank(agent);
        vm.expectRevert(CountersignVault.PolicyMismatch.selector);
        vault.execute(path, p, sig);
        // and the removed guardian cannot sign for the new policy either
        p.policyHash = vault.policyHash();
        sig = sign(p, guardianPk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, sig);
    }

    function test_OnlyOwnerAdminFunctions() public {
        CountersignVault.Mandate memory m = vault.mandate();
        address[3] memory callers = [agent, guardian, attacker];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.setMandate(m);
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.unpause();
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.setAgent(callers[i]);
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.setCommittee(committeeOf(callers[i]), 1);
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.withdraw(address(usdt), 1);
            vm.expectRevert(CountersignVault.NotOwner.selector);
            vault.transferOwnership(callers[i]);
            vm.stopPrank();
        }
    }

    function test_Tighten_ByAgent() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.maxTradeQuote = 20e6;
        m.cooldown = 600;
        m.assetsMask = 2; // ETH only
        m.tiersMask = 3; // risk appetite medium
        bytes32 oldHash = vault.policyHash();
        vm.prank(agent);
        vault.tighten(m);
        assertEq(vault.mandate().maxTradeQuote, 20e6);
        assertTrue(vault.policyHash() != oldHash);
    }

    function test_Tighten_CannotLoosen() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.maxTradeQuote = 60e6;
        vm.prank(agent);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        vault.tighten(m);

        m = vault.mandate();
        m.maxSlippageBps = 200;
        vm.prank(guardian);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        vault.tighten(m);

        m = vault.mandate();
        m.expiry += 1;
        vm.prank(agent);
        vm.expectRevert(CountersignVault.NotTighter.selector);
        vault.tighten(m);
    }

    function test_Tighten_AttackerCannot() public {
        CountersignVault.Mandate memory m = vault.mandate();
        vm.prank(attacker);
        vm.expectRevert(CountersignVault.NotAuthorized.selector);
        vault.tighten(m);
    }

    function test_SetMandate_Bounds() public {
        CountersignVault.Mandate memory m = vault.mandate();
        m.maxSlippageBps = 501;
        vm.prank(owner);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        vault.setMandate(m);

        m = vault.mandate();
        m.assetsMask = 4; // only 2 assets registered
        vm.prank(owner);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        vault.setMandate(m);

        m = vault.mandate();
        m.expiry = uint64(block.timestamp);
        vm.prank(owner);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        vault.setMandate(m);
    }

    function test_CircuitBreaker_GuardianPauses_OnlyOwnerUnpauses() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
        vm.prank(agent);
        vm.expectRevert(CountersignVault.NotOwner.selector);
        vault.unpause();
        vm.prank(attacker);
        vm.expectRevert(CountersignVault.NotAuthorized.selector);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_Withdraw_OwnerOnly_UpdatesTracking() public {
        uint256 bought = doBuy(address(whsk), 40e6);
        vm.prank(owner);
        vault.withdraw(address(whsk), bought / 2);
        assertEq(whsk.balanceOf(owner), bought / 2);
        (uint128 qty, uint128 cost) = vault.positions(address(whsk));
        assertEq(qty, bought - bought / 2);
        assertApproxEqAbs(cost, 20e6, 1);

        vm.prank(owner);
        vault.withdraw(address(usdt), 460e6);
        assertEq(usdt.balanceOf(owner), 460e6);
    }

    function test_Withdraw_UntrackedFirst() public {
        uint256 bought = doBuy(address(whsk), 10e6);
        whsk.mint(address(vault), 5e18);
        vm.prank(owner);
        vault.withdraw(address(whsk), 5e18);
        (uint128 qty,) = vault.positions(address(whsk));
        assertEq(qty, bought);
    }

    function test_DepositAsset_CostBasisAtTwap() public {
        whsk.mint(owner, 1000e18);
        vm.startPrank(owner);
        whsk.approve(address(vault), 1000e18);
        vault.depositAsset(address(whsk), 1000e18);
        vm.stopPrank();
        (uint128 qty, uint128 cost) = vault.positions(address(whsk));
        assertEq(qty, 1000e18);
        assertApproxEqRel(cost, 80e6, 0.01e18); // ~0.08 USDT each
    }

    function test_OwnershipTwoStep() public {
        address newOwner = vm.addr(0x5AFE);
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), owner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
    }

    function test_OwnershipCannotGoToAgent() public {
        vm.prank(owner);
        vault.transferOwnership(agent);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidParams.selector);
        vault.acceptOwnership();
    }

    // ===================================================== decision anchoring

    function test_AnchorDecisions_Contiguous() public {
        vm.prank(agent);
        vault.anchorDecisions(keccak256("root0"), 0, 99);
        assertEq(vault.nextDecisionSeq(), 100);
        assertEq(vault.anchors(0), keccak256("root0"));

        vm.prank(agent);
        vm.expectRevert(CountersignVault.BadDecisionRange.selector);
        vault.anchorDecisions(keccak256("gap"), 101, 120);

        vm.prank(attacker);
        vm.expectRevert(CountersignVault.NotAgent.selector);
        vault.anchorDecisions(keccak256("x"), 100, 120);

        vm.prank(agent);
        vault.anchorDecisions(keccak256("root1"), 100, 120);
        assertEq(vault.anchorCount(), 2);
    }

    // ================================================================= fuzz

    function testFuzz_OnlyAgentCanExecute(address caller) public {
        vm.assume(caller != agent);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), 10e6);
        vm.prank(caller);
        vm.expectRevert(CountersignVault.NotAgent.selector);
        vault.execute(path, p, sig);
    }

    function testFuzz_OnlyGuardianKeyApproves(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != guardianPk);
        (bytes memory path, CountersignVault.ExecutionPermit memory p,) = buyPermit(address(whsk), 10e6);
        bytes[] memory sig = sign(p, pk);
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, sig);
    }

    function testFuzz_CapAlwaysEnforced(uint256 amountIn) public {
        amountIn = bound(amountIn, 50e6 + 1, 500e6);
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes[] memory sig) =
            buyPermit(address(whsk), amountIn);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CountersignVault.TradeTooLarge.selector, amountIn, 50e6));
        vault.execute(path, p, sig);
    }

    function testFuzz_TightenNeverLoosens(uint128 maxTrade, uint32 cooldown, uint16 slip, uint8 tiers) public {
        CountersignVault.Mandate memory c = vault.mandate();
        CountersignVault.Mandate memory m = vault.mandate(); // separate copy (memory structs alias)
        m.maxTradeQuote = maxTrade;
        m.cooldown = cooldown;
        m.maxSlippageBps = uint16(bound(slip, 0, 500));
        m.tiersMask = uint8(bound(tiers, 0, 7));
        bool tighter = m.maxTradeQuote <= c.maxTradeQuote && m.cooldown >= c.cooldown
            && m.maxSlippageBps <= c.maxSlippageBps && (m.tiersMask & ~c.tiersMask) == 0;
        vm.prank(agent);
        if (!tighter) vm.expectRevert(CountersignVault.NotTighter.selector);
        vault.tighten(m);
        CountersignVault.Mandate memory n = vault.mandate();
        assertLe(n.maxTradeQuote, c.maxTradeQuote);
        assertGe(n.cooldown, c.cooldown);
        assertLe(n.maxSlippageBps, c.maxSlippageBps);
    }

    // ============================================================== helpers

    function _shiftPrice(MockPool pool, address base, int24 deltaTicks) internal {
        int24 t = pool.tick();
        pool.setTick(pool.token0() == base ? t + deltaTicks : t - deltaTicks);
    }

    function _quotePath3(uint256 amountIn) internal view returns (uint256) {
        uint256 a = router.quoteHop(address(usdt), address(whsk), FEE, amountIn);
        uint256 b = router.quoteHop(address(whsk), address(weth), FEE, a);
        return router.quoteHop(address(weth), address(usdt), FEE, b);
    }

    function _cloneOf(address implementation) internal returns (CountersignVault v) {
        address[] memory assets = new address[](2);
        assets[0] = address(whsk);
        assets[1] = address(weth);
        uint24[] memory fees = new uint24[](2);
        fees[0] = FEE;
        fees[1] = FEE;
        VaultFactory f = new VaultFactory(implementation);
        vm.prank(owner);
        v = CountersignVault(f.createVault(agent, committee1(), 1, address(usdt), assets, fees, defaultMandate()));
    }

    function _permitFor(
        CountersignVault v,
        bytes memory path,
        uint8 tier,
        uint256 amountIn,
        uint256 minOut,
        uint256 ref
    ) internal returns (CountersignVault.ExecutionPermit memory p) {
        p = permit(path, tier, amountIn, minOut, ref, bytes32(0));
        p.policyHash = v.policyHash();
    }

    function _signFor(CountersignVault v, CountersignVault.ExecutionPermit memory p)
        internal
        view
        returns (bytes[] memory)
    {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(guardianPk, v.permitDigest(p));
        return one(abi.encodePacked(r, s, vv));
    }
}

