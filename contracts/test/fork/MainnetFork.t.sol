// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {CountersignVault} from "../../src/CountersignVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {IERC20} from "../../src/interfaces/IExternal.sol";
import {HSK} from "../../script/Addresses.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);

    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256);
}

/// @notice Runs against a fork of HSK Chain mainnet (chain 177) with the REAL HSKSwap router,
///         factory, pools and tokens. Nothing is broadcast.
///         Run: forge test --match-path "test/fork/*" (needs network access to mainnet.hsk.xyz)
contract MainnetForkTest is Test {
    uint256 constant FORK_BLOCK = 30_528_000;

    uint256 agentPk = 0xB0B;
    uint256 guardianPk = 0x6A4D;
    address owner = makeAddr("ledgerOwner");
    address agent;
    address guardian;

    CountersignVault vault;
    IQuoterV2 quoter = IQuoterV2(HSK.QUOTER_V2);
    uint256 n;
    bool forked;

    function setUp() public {
        try vm.createSelectFork("hsk_mainnet", FORK_BLOCK) {
            forked = true;
        } catch {
            return;
        }
        agent = vm.addr(agentPk);
        guardian = vm.addr(guardianPk);

        CountersignVault impl = new CountersignVault(HSK.SWAP_ROUTER_02, HSK.V3_FACTORY);
        VaultFactory factory = new VaultFactory(address(impl));

        address[] memory assets = new address[](3);
        assets[0] = HSK.WHSK;
        assets[1] = HSK.WETH;
        assets[2] = HSK.WBTC;
        uint24[] memory fees = new uint24[](3);
        fees[0] = 3000;
        fees[1] = 3000;
        fees[2] = 3000;

        CountersignVault.Mandate memory m = CountersignVault.Mandate({
            maxTradeQuote: 5e6,
            dailyVolumeQuote: 20e6,
            dailyLossQuote: 2e6,
            maxExposureQuote: 10e6,
            minArbProfitQuote: 0.001e6,
            cooldown: 0,
            twapWindow: 1800,
            maxSlippageBps: 100,
            minEdgeBps: 30,
            tiersMask: 7,
            assetsMask: 7,
            expiry: uint64(block.timestamp + 7 days)
        });
        vm.prank(owner);
        vault = CountersignVault(factory.createVault(agent, guardian, HSK.USDT, assets, fees, m));
        deal(HSK.USDT, address(vault), 20e6);
        assertEq(IERC20(HSK.USDT).balanceOf(address(vault)), 20e6, "deal USDT");
    }

    modifier onlyFork() {
        vm.skip(!forked); // reported as SKIPPED (not a false PASS) when mainnet RPC is unreachable
        _;
    }

    function _permit(bytes memory path, uint8 tier, uint256 amountIn, uint256 minOut, uint256 ref)
        internal
        returns (CountersignVault.ExecutionPermit memory p, bytes memory sig)
    {
        p = CountersignVault.ExecutionPermit({
            tradeId: keccak256(abi.encode("fork", ++n)),
            tier: tier,
            pathHash: keccak256(path),
            amountIn: amountIn,
            minOut: minOut,
            refAmountOut: ref,
            expectedNetValue: 0,
            predictionHash: keccak256("fork prediction"),
            decisionHash: keccak256(abi.encode("decision", n)),
            policyHash: vault.policyHash(),
            deadline: uint64(block.timestamp + 120)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianPk, vault.permitDigest(p));
        sig = abi.encodePacked(r, s, v);
    }

    function _quote(address tIn, address tOut, uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = quoter.quoteExactInputSingle(IQuoterV2.QuoteExactInputSingleParams(tIn, tOut, amountIn, 3000, 0));
    }

    function _buy(address asset, uint256 amountIn) internal returns (uint256 out) {
        bytes memory path = abi.encodePacked(HSK.USDT, uint24(3000), asset);
        uint256 q = _quote(HSK.USDT, asset, amountIn);
        (CountersignVault.ExecutionPermit memory p, bytes memory sig) = _permit(path, 3, amountIn, q * 995 / 1000, 0);
        uint256 g = gasleft();
        vm.prank(agent);
        out = vault.execute(path, p, sig);
        console2.log("BUY gas used:", g - gasleft());
        assertGe(out, q * 995 / 1000);
    }

    function test_Fork_BuyAndSellWHSK() public onlyFork {
        uint256 floor = vault.twapFloor(HSK.USDT, HSK.WHSK, 3000, 2e6);
        uint256 q = _quote(HSK.USDT, HSK.WHSK, 2e6);
        console2.log("2 USDT -> WHSK quote:", q);
        console2.log("TWAP floor (30m, 1%):", floor);
        assertLt(floor, q * 995 / 1000, "floor must sit below a healthy quote");

        uint256 got = _buy(HSK.WHSK, 2e6);
        (uint128 qty, uint128 cost) = vault.positions(HSK.WHSK);
        assertEq(qty, got);
        assertEq(cost, 2e6);

        bytes memory path = abi.encodePacked(HSK.WHSK, uint24(3000), HSK.USDT);
        uint256 qs = _quote(HSK.WHSK, HSK.USDT, got);
        (CountersignVault.ExecutionPermit memory p, bytes memory sig) = _permit(path, 0, got, qs * 995 / 1000, 0);
        vm.prank(agent);
        uint256 back = vault.execute(path, p, sig);
        (, int128 pnl) = vault.currentDay();
        console2.log("round trip USDT back:", back);
        console2.logInt(pnl);
        assertEq(pnl, int128(int256(back) - 2e6));
        assertLt(pnl, 0, "a round trip pays two pool fees");
    }

    function test_Fork_BuyWETHandWBTC() public onlyFork {
        _buy(HSK.WETH, 3e6);
        _buy(HSK.WBTC, 3e6);
        (, uint128 c1) = vault.positions(HSK.WETH);
        (, uint128 c2) = vault.positions(HSK.WBTC);
        assertEq(c1 + c2, 6e6);
    }

    function test_Fork_TwapFloorRejectsWorthlessMinOut() public onlyFork {
        bytes memory path = abi.encodePacked(HSK.USDT, uint24(3000), HSK.WHSK);
        (CountersignVault.ExecutionPermit memory p, bytes memory sig) = _permit(path, 3, 2e6, 1, 0);
        vm.prank(agent);
        vm.expectPartialRevert(CountersignVault.BelowTwapFloor.selector);
        vault.execute(path, p, sig);
    }

    function test_Fork_ArbProfitOrRevert_RealRouter() public onlyFork {
        // USDT -> WHSK -> USDT through the same pool can never profit (two fees). Even with a
        // Guardian signature, the real HSKSwap router reverts and principal is untouched.
        bytes memory path = abi.encodePacked(HSK.USDT, uint24(3000), HSK.WHSK, uint24(3000), HSK.USDT);
        (uint256 q,,,) = quoter.quoteExactInput(path, 2e6);
        console2.log("cycle quote for 2 USDT:", q);
        assertLt(q, 2e6);
        (CountersignVault.ExecutionPermit memory p, bytes memory sig) = _permit(path, 1, 2e6, 2e6 + 1000, 0);
        uint256 before = IERC20(HSK.USDT).balanceOf(address(vault));
        vm.prank(agent);
        vm.expectRevert();
        vault.execute(path, p, sig);
        assertEq(IERC20(HSK.USDT).balanceOf(address(vault)), before);
    }

    function test_Fork_StolenAgentKeyCannotTrade() public onlyFork {
        bytes memory path = abi.encodePacked(HSK.USDT, uint24(3000), HSK.WHSK);
        (CountersignVault.ExecutionPermit memory p,) = _permit(path, 3, 2e6, 1, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, vault.permitDigest(p));
        vm.prank(agent);
        vm.expectRevert(CountersignVault.InvalidPermit.selector);
        vault.execute(path, p, abi.encodePacked(r, s, v));
    }

    function test_Fork_OwnerWithdrawsEverything() public onlyFork {
        _buy(HSK.WHSK, 2e6);
        uint256 whskBal = IERC20(HSK.WHSK).balanceOf(address(vault));
        vm.startPrank(owner);
        vault.pause();
        vault.setAgent(address(0));
        vault.withdraw(HSK.USDT, 18e6);
        vault.withdraw(HSK.WHSK, whskBal);
        vm.stopPrank();
        assertEq(IERC20(HSK.USDT).balanceOf(owner), 18e6);
        assertEq(IERC20(HSK.WHSK).balanceOf(owner), whskBal);
    }
}
