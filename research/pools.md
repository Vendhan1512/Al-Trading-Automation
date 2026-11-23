# HSKSwap pool map and decision gate (Phase 0)

Read from HSK Chain mainnet (chain 177) on **23 Nov 2026**, around block **30,528,400**. Gas price at the time was **500 gwei**. Every number below comes from an RPC or explorer call, not from another project's README.

## Core contracts (all verified on-chain)
| Contract | Address | Check |
|---|---|---|
| SwapRouter02 | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` | `factory()` = V3 factory; `WETH9()` = WHSK; selectors `exactInput` (0xb858183f) and `exactInputSingle` (0x04e45aaf) present |
| UniswapV3Factory | `0x972cA9D1662F5e029cD18327D29026532E84c742` | 17 `PoolCreated` events |
| QuoterV2 | `0x1095A23A4812185344D9abd5143191D8a3A7E36f` | `factory()` matches. `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` has identical code (8,273 bytes), so the two addresses other submissions quoted are both valid |
| WHSK | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | 18 decimals |
| USDT | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | **6 decimals** |
| WETH | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` | 18 decimals |
| WBTC | `0x6119CA49a79f5825C8B345F8d7aC36B272565b14` | 8 decimals |
| APRO HSK/USD | `0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b` | `description()` = "HSK/USD", 8 decimals; last print 0.08049 at ts 1795386575 (~5 h old at the time of reading) |

## Pools with liquidity (fee 3000 unless noted)
| Pool | Address | Reserves | ≈ TVL | Spot | Oracle cardinality |
|---|---|---|---|---|---|
| **WHSK/USDT** | `0x4ff5…05dC` | 5.19 M WHSK / 419.5 k USDT | **~$840 k** | 0.08079 USDT | 240 |
| **WBTC/USDT** | `0xd9EA…449A` | 0.742 WBTC / 44.9 k USDT | **~$90 k** | 60,479 USDT | 240 |
| **WETH/USDT** | `0xb92b…4C16` | 24.59 WETH / 41.8 k USDT | **~$84 k** | 1,699.7 USDT | 240 |
| USDC.e/WHSK | `0xb580…0e02` | 0.077 USDC.e / 0.81 WHSK | < $1 | — | — |
| A/B, A/USDT, B/USDT, WHSK/A, WHSK/B (several tiers) | — | test tokens "A" and "B" with junk or near-zero real value | — | — | — |
| NVDAs / AAPLs / QQQs / TSLAs / CRCLs pools | — | 6 pools, zero liquidity | 0 | — | — |

All three real pools support a **30-minute TWAP** (`observe([1800,0])` succeeds). The vault uses this as its output floor on mainnet.

## Decision gate: Tier A (atomic on-chain arbitrage)
**Result: no-go as a live profit source today.**

- The real-liquidity graph is a **star**: WHSK, WETH and WBTC each pair only with USDT, in one fee tier each. There is no cycle and no second fee tier among real assets.
- The only non-star pools hold test tokens or under $1 (USDC.e/WHSK).
- Fork test `test_Fork_ArbProfitOrRevert_RealRouter`: the cycle USDT→WHSK→USDT quotes 1.988 USDT for 2 USDT in, and the vault plus the real router revert the attempt with principal untouched.

**What we keep:**
1. `executeArb` (profit-or-revert) stays in the contract. It costs nothing until a cycle exists, and the Tier A scanner keeps running and logs honest "no profitable cycle" results.
2. The **"prove it" pillar moves to Tier B, edge-or-revert.** A spread entry signed by the Guardian must have `minOut ≥ refAmountOut × (1 + minEdgeBps)`, and this is enforced on-chain. The vault cannot buy unless the fill beats the Guardian's committed fair value by the mandate's minimum edge. The router's `amountOutMinimum` makes this atomic: the trade **fills with the edge or reverts**.

## Cost model (measured on a mainnet fork)
| Action | Gas | HSK @ 500 gwei | USD @ $0.081 |
|---|---|---|---|
| Implementation + factory deploy | ~4.5 M | ~2.3 | ~$0.19 |
| `createVault` (clone + init) | ~0.45 M (est.) | ~0.23 | ~$0.02 |
| `execute` BUY/SELL | 205 k – 284 k | ~0.10 – 0.14 | ~$0.01 |
| Round-trip pool fees | 2 × 0.30% | — | 2 USDT → 1.988 USDT measured |

The edge required for a Tier B round trip to be profitable is about **0.60% + gas + impact**. That is why the mandate's `minEdgeBps` exists and why most ticks should end in WAIT.
