// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CountersignVault} from "../src/CountersignVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {IERC20} from "../src/interfaces/IExternal.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// @notice Testnet-only end-to-end run of the two-key flow with REAL transactions on chain 133.
///   A throwaway TEST owner (TEST_OWNER_PK) creates a vault and deposits a little WHSK; the agent
///   then sells it with a Guardian-countersigned permit. A self-signed permit is shown to revert
///   (simulated only, nothing broadcast for it).
contract E2ETestnet is Script {
    address constant WHSK = 0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6;
    address constant USDT = 0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F;
    address constant QUOTER = 0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC;

    function run() external {
        require(block.chainid == 133, "testnet only");
        uint256 ownerPk = vm.envUint("TEST_OWNER_PK");
        uint256 agentPk = vm.envUint("AGENT_PK");
        uint256 guardianPk = vm.envUint("GUARDIAN_PK");
        address factory = vm.parseJsonAddress(vm.readFile("./deployments/133.json"), ".vaultFactory");

        address[] memory assets = new address[](1);
        assets[0] = WHSK;
        uint24[] memory fees = new uint24[](1);
        fees[0] = 3000;
        CountersignVault.Mandate memory m = CountersignVault.Mandate({
            maxTradeQuote: 1e18,
            dailyVolumeQuote: 5e18,
            dailyLossQuote: 0.5e18,
            maxExposureQuote: 3e18,
            minArbProfitQuote: 0.001e18,
            cooldown: 60,
            twapWindow: 300,
            maxSlippageBps: 300,
            minEdgeBps: 30,
            tiersMask: 7,
            assetsMask: 1,
            expiry: uint64(block.timestamp + 14 days)
        });

        // 1) test owner creates the vault and deposits 0.01 WHSK with a TWAP cost basis
        vm.startBroadcast(ownerPk);
        CountersignVault vault = CountersignVault(
            VaultFactory(factory).createVault(vm.addr(agentPk), vm.addr(guardianPk), USDT, assets, fees, m)
        );
        IWETH(WHSK).deposit{value: 0.01 ether}();
        IWETH(WHSK).approve(address(vault), 0.01 ether);
        vault.depositAsset(WHSK, 0.01 ether);
        vm.stopBroadcast();
        console2.log("E2E vault:", address(vault));

        // 2) Guardian prices and countersigns an exit (SELL 0.005 WHSK)
        bytes memory path = abi.encodePacked(WHSK, uint24(3000), USDT);
        (uint256 q,,,) =
            IQuoterV2(QUOTER).quoteExactInputSingle(IQuoterV2.QuoteExactInputSingleParams(WHSK, USDT, 0.005 ether, 3000, 0));
        CountersignVault.ExecutionPermit memory p = CountersignVault.ExecutionPermit({
            tradeId: keccak256(abi.encode("e2e-testnet", address(vault), block.timestamp)),
            tier: 0,
            pathHash: keccak256(path),
            amountIn: 0.005 ether,
            minOut: q * 99 / 100,
            refAmountOut: 0,
            expectedNetValue: 0,
            predictionHash: bytes32(0),
            decisionHash: keccak256("e2e: guardian-approved exit"),
            policyHash: vault.policyHash(),
            deadline: uint64(block.timestamp + 600)
        });
        bytes32 digest = vault.permitDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianPk, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(agentPk, digest);

        // 3) attack check (simulated): the agent with a self-signed permit is refused
        vm.prank(vm.addr(agentPk));
        try vault.execute(path, p, abi.encodePacked(r2, s2, v2)) {
            revert("SECURITY FAILURE: self-signed permit accepted");
        } catch (bytes memory err) {
            require(bytes4(err) == CountersignVault.InvalidPermit.selector, "unexpected error");
            console2.log("Self-signed permit refused: InvalidPermit()");
        }

        // 4) the agent submits the Guardian-countersigned permit (real tx)
        vm.startBroadcast(agentPk);
        uint256 out = vault.execute(path, p, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
        console2.log("Countersigned SELL executed, USDT out:", out);
        console2.logBytes32(p.tradeId);
    }
}
