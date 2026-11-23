// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {MockERC20, MockPool, MockFactory, MockRouter} from "./mocks/Mocks.sol";

abstract contract BaseTest is Test {
    uint24 constant FEE = 3000;

    uint256 ownerPk = 0xA11CE;
    uint256 agentPk = 0xB0B;
    uint256 guardianPk = 0x6A4D;
    uint256 attackerPk = 0xBAD;
    address owner;
    address agent;
    address guardian;
    address attacker;

    MockERC20 usdt;
    MockERC20 whsk;
    MockERC20 weth;
    MockFactory pf;
    MockRouter router;
    MockPool whskUsdt;
    MockPool wethUsdt;
    MockPool whskWeth;

    CountersignVault impl;
    VaultFactory factory;
    CountersignVault vault;

    uint256 nonceCounter;

    function setUp() public virtual {
        vm.warp(1_790_000_000); // fixed, realistic timestamp (Sep 2026)
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        guardian = vm.addr(guardianPk);
        attacker = vm.addr(attackerPk);

        usdt = new MockERC20("Tether USD", "USDT", 6);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        pf = new MockFactory();
        router = new MockRouter(pf);
        whskUsdt = _pool(address(whsk), address(usdt), -301585); // ~0.08 USDT / WHSK
        wethUsdt = _pool(address(weth), address(usdt), -201941); // ~1700 USDT / WETH
        whskWeth = _pool(address(whsk), address(weth), -99645); // ~0.08/1700

        impl = new CountersignVault(address(router), address(pf));
        factory = new VaultFactory(address(impl));

        address[] memory assets = new address[](2);
        assets[0] = address(whsk);
        assets[1] = address(weth);
        uint24[] memory fees = new uint24[](2);
        fees[0] = FEE;
        fees[1] = FEE;

        vm.prank(owner);
        vault = CountersignVault(factory.createVault(agent, guardian, address(usdt), assets, fees, defaultMandate()));
        usdt.mint(address(vault), 500e6);
    }

    /// @param tickBase price of `base` in `quoteTok` expressed as a tick assuming base is token0
    function _pool(address base, address quoteTok, int24 tickBase) internal returns (MockPool p) {
        p = new MockPool(base, quoteTok);
        p.setTick(p.token0() == base ? tickBase : -tickBase);
        pf.setPool(base, quoteTok, FEE, address(p));
    }

    function defaultMandate() internal view returns (CountersignVault.Mandate memory m) {
        m = CountersignVault.Mandate({
            maxTradeQuote: 50e6,
            dailyVolumeQuote: 150e6,
            dailyLossQuote: 10e6,
            maxExposureQuote: 100e6,
            minArbProfitQuote: 0.01e6,
            cooldown: 60,
            twapWindow: 300,
            maxSlippageBps: 100,
            minEdgeBps: 50,
            tiersMask: 7,
            assetsMask: 3,
            expiry: uint64(block.timestamp + 7 days)
        });
    }

    // ------------------------------------------------------------- helpers

    function path1(address a, address b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, FEE, b);
    }

    function permit(bytes memory path, uint8 tier, uint256 amountIn, uint256 minOut, uint256 ref, bytes32 pred)
        internal
        returns (CountersignVault.ExecutionPermit memory p)
    {
        p = CountersignVault.ExecutionPermit({
            tradeId: keccak256(abi.encode("trade", ++nonceCounter)),
            tier: tier,
            pathHash: keccak256(path),
            amountIn: amountIn,
            minOut: minOut,
            refAmountOut: ref,
            expectedNetValue: int256(1e4),
            predictionHash: pred,
            decisionHash: keccak256(abi.encode("decision", nonceCounter)),
            policyHash: vault.policyHash(),
            deadline: uint64(block.timestamp + 120)
        });
    }

    function sign(CountersignVault.ExecutionPermit memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.permitDigest(p));
        return abi.encodePacked(r, s, v);
    }

    /// @dev A valid Guardian-approved tier-B BUY of `amountIn` USDT -> asset.
    function buyPermit(address asset, uint256 amountIn)
        internal
        returns (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes memory sig)
    {
        path = path1(address(usdt), asset);
        uint256 q = router.quoteHop(address(usdt), asset, FEE, amountIn);
        uint256 minOut = q * 9990 / 10_000;
        uint256 ref = q * 9900 / 10_000; // reference says fair value is 1% worse than the pool
        p = permit(path, 2, amountIn, minOut, ref, bytes32(0));
        sig = sign(p, guardianPk);
    }

    function doBuy(address asset, uint256 amountIn) internal returns (uint256 out) {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes memory sig) = buyPermit(asset, amountIn);
        vm.prank(agent);
        out = vault.execute(path, p, sig);
    }

    function sellPermit(address asset, uint256 amountIn, uint8 tier)
        internal
        returns (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes memory sig)
    {
        path = path1(asset, address(usdt));
        uint256 q = router.quoteHop(asset, address(usdt), FEE, amountIn);
        p = permit(path, tier, amountIn, q * 9990 / 10_000, q * 9900 / 10_000, keccak256("prediction"));
        sig = sign(p, guardianPk);
    }

    function doSell(address asset, uint256 amountIn, uint8 tier) internal returns (uint256 out) {
        (bytes memory path, CountersignVault.ExecutionPermit memory p, bytes memory sig) =
            sellPermit(asset, amountIn, tier);
        vm.prank(agent);
        out = vault.execute(path, p, sig);
    }
}
