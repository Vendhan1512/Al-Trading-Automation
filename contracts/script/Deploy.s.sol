// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {HSK} from "./Addresses.sol";

/// @notice Network-specific constants.
library Net {
    struct Config {
        address router;
        address v3Factory;
        address quote;
        address[] assets;
        uint24[] fees;
        uint32 twapWindow;
    }

    function get(uint256 chainId) internal pure returns (Config memory c) {
        if (chainId == 177) {
            c.router = HSK.SWAP_ROUTER_02;
            c.v3Factory = HSK.V3_FACTORY;
            c.quote = HSK.USDT;
            c.assets = new address[](3);
            c.assets[0] = HSK.WHSK;
            c.assets[1] = HSK.WETH;
            c.assets[2] = HSK.WBTC;
            c.fees = new uint24[](3);
            c.fees[0] = 3000;
            c.fees[1] = 3000;
            c.fees[2] = 3000;
            c.twapWindow = 1800;
        } else if (chainId == 133) {
            // HSKSwap testnet (verified 23 Nov 2026: router.factory()/WETH9() match, pool live)
            c.router = 0xa6914E66690c6794244B5f66a09eAEbf66254237;
            c.v3Factory = 0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0;
            c.quote = 0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F; // pool USDT, 18 dec on testnet
            c.assets = new address[](1);
            c.assets[0] = 0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6; // testnet WHSK
            c.fees = new uint24[](1);
            c.fees[0] = 3000;
            c.twapWindow = 300; // testnet pool has observation cardinality 16
        } else {
            revert("unsupported chain");
        }
    }
}

/// @notice Step 1 — deploy the vault implementation and the factory.
///   forge script script/Deploy.s.sol --rpc-url hsk_testnet --broadcast --private-key $DEPLOYER_PK
///   Mainnet additionally requires CONFIRM_MAINNET=yes.
contract Deploy is Script {
    function run() external returns (CountersignVault impl, VaultFactory factory) {
        if (block.chainid == 177) {
            require(
                keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256("yes"),
                "set CONFIRM_MAINNET=yes to deploy on HSK mainnet"
            );
        }
        Net.Config memory c = Net.get(block.chainid);

        vm.startBroadcast();
        impl = new CountersignVault(c.router, c.v3Factory);
        factory = new VaultFactory(address(impl));
        vm.stopBroadcast();

        console2.log("CountersignVault implementation:", address(impl));
        console2.log("VaultFactory:", address(factory));

        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "router", c.router);
        vm.serializeAddress(k, "v3Factory", c.v3Factory);
        vm.serializeAddress(k, "quote", c.quote);
        vm.serializeAddress(k, "assets", c.assets);
        vm.serializeAddress(k, "implementation", address(impl));
        string memory json = vm.serializeAddress(k, "vaultFactory", address(factory));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}

/// @notice Step 2 — the OWNER creates their vault. On mainnet, run it with the hardware wallet:
///   AGENT=0x.. GUARDIAN=0x.. forge script script/Deploy.s.sol:CreateVault \
///     --rpc-url hsk_mainnet --broadcast --ledger --sender <ledger address>
///   Optional env: MAX_TRADE, DAILY_VOLUME, DAILY_LOSS, MAX_EXPOSURE (quote units),
///   COOLDOWN, SLIPPAGE_BPS, MIN_EDGE_BPS, TIERS, ASSETS_MASK, DAYS.
contract CreateVault is Script {
    function run() external returns (address vault) {
        Net.Config memory c = Net.get(block.chainid);
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        address factory = vm.parseJsonAddress(vm.readFile(path), ".vaultFactory");
        uint256 unit = block.chainid == 133 ? 1e18 : 1e6; // quote decimals

        CountersignVault.Mandate memory m = CountersignVault.Mandate({
            maxTradeQuote: uint128(vm.envOr("MAX_TRADE", 2 * unit)),
            dailyVolumeQuote: uint128(vm.envOr("DAILY_VOLUME", 10 * unit)),
            dailyLossQuote: uint128(vm.envOr("DAILY_LOSS", 1 * unit)),
            maxExposureQuote: uint128(vm.envOr("MAX_EXPOSURE", 5 * unit)),
            minArbProfitQuote: uint128(vm.envOr("MIN_ARB_PROFIT", unit / 1000)),
            cooldown: uint32(vm.envOr("COOLDOWN", uint256(120))),
            twapWindow: c.twapWindow,
            maxSlippageBps: uint16(vm.envOr("SLIPPAGE_BPS", uint256(100))),
            minEdgeBps: uint16(vm.envOr("MIN_EDGE_BPS", uint256(30))),
            tiersMask: uint8(vm.envOr("TIERS", uint256(7))),
            assetsMask: uint8(vm.envOr("ASSETS_MASK", (uint256(1) << c.assets.length) - 1)),
            expiry: uint64(block.timestamp + vm.envOr("DAYS", uint256(14)) * 1 days)
        });

        vm.startBroadcast();
        vault = VaultFactory(factory)
            .createVault(vm.envAddress("AGENT"), vm.envAddress("GUARDIAN"), c.quote, c.assets, c.fees, m);
        vm.stopBroadcast();
        console2.log("Vault:", vault);
        console2.log("Owner:", CountersignVault(vault).owner());
        console2.logBytes32(CountersignVault(vault).policyHash());
    }
}
