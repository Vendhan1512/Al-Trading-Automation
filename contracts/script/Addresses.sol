// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice HSK Chain mainnet (chain 177) addresses, each read from chain on 23 Nov 2026
///         (block ~30,528,400). See research/pools.md for how each was verified.
library HSK {
    uint256 internal constant CHAIN_ID = 177;

    // HSKSwap (Uniswap V3 fork)
    address internal constant SWAP_ROUTER_02 = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3; // factory() & WETH9() match
    address internal constant V3_FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;
    address internal constant QUOTER_V2 = 0x1095A23A4812185344D9abd5143191D8a3A7E36f; // 0x603f…BFDD is identical code

    // Tokens
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1; // 18 dec
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029; // 6 dec
    address internal constant WETH = 0xefd4bC9afD210517803f293ABABd701CaeeCdfd0; // 18 dec
    address internal constant WBTC = 0x6119CA49a79f5825C8B345F8d7aC36B272565b14; // 8 dec

    // Pools with real liquidity (all fee 3000, observation cardinality 240)
    address internal constant POOL_WHSK_USDT = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address internal constant POOL_WETH_USDT = 0xb92b79ed6b370D5cFee2E14B1D0983C258304C16;
    address internal constant POOL_WBTC_USDT = 0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A;

    // Oracles (reference only, never execution price)
    address internal constant APRO_HSK_USD = 0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b; // 8 dec
}
