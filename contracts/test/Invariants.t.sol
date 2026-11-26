// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// @dev Drives the vault with a mix of legitimate Guardian-approved trades and hostile calls
///      from the agent, the Guardian and an attacker. The owner never acts.
contract Handler is Test {
    CountersignVault vault;
    MockRouter router;
    address usdt;
    address[] assets;
    address agent;
    address guardian;
    address attacker;
    uint256 guardianPk;
    uint256 agentPk;
    uint256 n;

    uint256 public legitTrades;

    constructor(
        CountersignVault v,
        MockRouter r,
        address quote,
        address[] memory a,
        address ag,
        address g,
        address at,
        uint256 gPk,
        uint256 aPk
    ) {
        vault = v;
        router = r;
        usdt = quote;
        assets = a;
        agent = ag;
        guardian = g;
        attacker = at;
        guardianPk = gPk;
        agentPk = aPk;
    }

    function _permit(bytes memory path, uint8 tier, uint256 amountIn, uint256 minOut, uint256 ref)
        internal
        returns (CountersignVault.ExecutionPermit memory p)
    {
        p = CountersignVault.ExecutionPermit({
            tradeId: keccak256(abi.encode(++n)),
            tier: tier,
            pathHash: keccak256(path),
            amountIn: amountIn,
            minOut: minOut,
            refAmountOut: ref,
            expectedNetValue: 1, // v2: entries must carry a positive committee-signed expectation
            predictionHash: keccak256("p"),
            decisionHash: bytes32(0),
            policyHash: vault.policyHash(),
            deadline: uint64(block.timestamp + 60)
        });
    }

    function _sign(CountersignVault.ExecutionPermit memory p, uint256 pk) internal view returns (bytes[] memory a) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.permitDigest(p));
        a = new bytes[](1);
        a[0] = abi.encodePacked(r, s, v);
    }

    function legitBuy(uint256 assetSeed, uint256 amountIn, uint8 tierSeed) external {
        address asset = assets[assetSeed % assets.length];
        amountIn = bound(amountIn, 1e5, 60e6); // some above the 50 USDT cap
        uint8 tier = tierSeed % 2 == 0 ? 2 : 3;
        bytes memory path = abi.encodePacked(usdt, uint24(3000), asset);
        uint256 q = router.quoteHop(usdt, asset, 3000, amountIn);
        CountersignVault.ExecutionPermit memory p = _permit(path, tier, amountIn, q * 999 / 1000, q * 99 / 100);
        bytes[] memory sig = _sign(p, guardianPk);
        vm.prank(agent);
        try vault.execute(path, p, sig) {
            legitTrades++;
        } catch {}
    }

    function legitSell(uint256 assetSeed, uint256 fraction) external {
        address asset = assets[assetSeed % assets.length];
        (uint128 qty,) = vault.positions(asset);
        if (qty == 0) return;
        uint256 amountIn = (uint256(qty) * bound(fraction, 1, 100)) / 100;
        if (amountIn == 0) return;
        bytes memory path = abi.encodePacked(asset, uint24(3000), usdt);
        uint256 q = router.quoteHop(asset, usdt, 3000, amountIn);
        CountersignVault.ExecutionPermit memory p = _permit(path, 0, amountIn, q * 999 / 1000, 0);
        bytes[] memory sig = _sign(p, guardianPk);
        vm.prank(agent);
        try vault.execute(path, p, sig) {
            legitTrades++;
        } catch {}
    }

    /// Agent tries to trade with a self-signed permit, any size, any route.
    function hostileAgentTrade(uint256 assetSeed, uint256 amountIn, uint256 minOut, bool buy) external {
        address asset = assets[assetSeed % assets.length];
        bytes memory path =
            buy ? abi.encodePacked(usdt, uint24(3000), asset) : abi.encodePacked(asset, uint24(3000), usdt);
        CountersignVault.ExecutionPermit memory p = _permit(path, 2, amountIn, minOut, 0);
        bytes[] memory sig = _sign(p, agentPk);
        vm.prank(agent);
        try vault.execute(path, p, sig) {} catch {}
    }

    /// Guardian or attacker tries admin and withdrawal paths.
    function hostileAdmin(uint256 who, uint256 amount, address to) external {
        address caller = who % 3 == 0 ? guardian : who % 3 == 1 ? agent : attacker;
        vm.startPrank(caller);
        try vault.withdraw(usdt, bound(amount, 0, 1e12)) {} catch {}
        try vault.setAgent(to) {} catch {}
        address[] memory g = new address[](1);
        g[0] = to;
        try vault.setCommittee(g, 1) {} catch {}
        try vault.transferOwnership(to) {} catch {}
        try vault.acceptOwnership() {} catch {}
        try vault.unpause() {} catch {}
        // attempt to LOOSEN the mandate (tightening is a legitimate agent right, tested separately)
        CountersignVault.Mandate memory m = vault.mandate();
        m.maxTradeQuote = uint128(bound(amount, m.maxTradeQuote + 1, type(uint128).max));
        m.dailyLossQuote = m.dailyLossQuote * 2 + 1;
        try vault.setMandate(m) {} catch {}
        try vault.tighten(m) {} catch {}
        vm.stopPrank();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }
}

contract InvariantsTest is BaseTest {
    Handler handler;
    CountersignVault.Mandate initial;

    function setUp() public override {
        super.setUp();
        initial = vault.mandate();
        address[] memory ok = new address[](2);
        ok[0] = address(router);
        ok[1] = owner;
        usdt.watch(address(vault), ok);
        whsk.watch(address(vault), ok);
        weth.watch(address(vault), ok);
        handler =
            new Handler(vault, router, address(usdt), vault.assets(), agent, guardian, attacker, guardianPk, agentPk);
        targetContract(address(handler));
    }

    /// Liveness: legitimate Guardian-approved trades do get through (the suite is not vacuous).
    function afterInvariant() public view virtual {
        assertGt(handler.legitTrades(), 0, "no legit trades executed");
    }

    /// Funds can only ever leave the vault to the router (swaps) or the owner (withdrawals).
    function invariant_NoLeakToThirdParties() public view virtual {
        assertFalse(usdt.leaked(), "usdt leaked");
        assertFalse(whsk.leaked(), "whsk leaked");
        assertFalse(weth.leaked(), "weth leaked");
    }

    /// Nobody but the owner can change who controls the vault.
    function invariant_RolesImmutableWithoutOwner() public view virtual {
        assertEq(vault.owner(), owner);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.agent(), agent);
    }

    /// The mandate can only ever become stricter without the owner.
    function invariant_MandateNeverLooser() public view virtual {
        CountersignVault.Mandate memory m = vault.mandate();
        assertLe(m.maxTradeQuote, initial.maxTradeQuote);
        assertLe(m.dailyLossQuote, initial.dailyLossQuote);
        assertLe(m.dailyVolumeQuote, initial.dailyVolumeQuote);
        assertLe(m.maxExposureQuote, initial.maxExposureQuote);
        assertLe(m.maxSlippageBps, initial.maxSlippageBps);
        assertGe(m.cooldown, initial.cooldown);
        assertLe(m.expiry, initial.expiry);
        assertEq(m.tiersMask & ~initial.tiersMask, 0);
        assertEq(m.assetsMask & ~initial.assetsMask, 0);
    }

    /// Per-asset exposure caps hold and tracked quantities are always backed by real balances.
    function invariant_CapsHold() public view virtual {
        address[] memory a = vault.assets();
        for (uint256 i; i < a.length; ++i) {
            (uint128 qty, uint128 cost) = vault.positions(a[i]);
            assertLe(cost, initial.maxExposureQuote);
            assertLe(qty, MockERC20(a[i]).balanceOf(address(vault)));
        }
    }
}

