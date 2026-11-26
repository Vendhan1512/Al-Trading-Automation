# Backtest — the live rules replayed on 30 days of HSK mainnet data

Generated 2026-11-26T17:18:36.601Z by `pnpm backtest` (agent/src/backtest). Window: 2026-10-27T17:14 → 2026-11-26T17:14 UTC.

Data: every Swap event on the three HSKSwap pools (WHSK 2386, WETH 278, WBTC 86 swaps) and Gate.io 5-minute candles. Parameters are the **live defaults, untuned**: 5 USDT per trade, entry band = pool fee + min edge + buffer = 70 bps, target = half the gap, invalidation = max(150 bps, gap), 6 h expiry, 3% TWAP stop-loss, gas 3,00,000 units at 500 gwei per swap.

| Asset | Period | Policy | Candidates | Refused by gate | Round trips | Wins / losses | Net P&L after fees + gas (USDT) | Gas (USDT) | Max drawdown (USDT) |
|---|---|---|---|---|---|---|---|---|---|
| WHSK | full 30 d | Countersign (fixed gate: half-gap exit) | 654 | 652 | 2 | 0 / 2 | -0.0667 | 0.0474 | 0.0667 |
| WHSK | full 30 d | first gate (full convergence) — the flaw | 257 | 243 | 14 | 0 / 14 | -0.7984 | 0.3450 | 0.7984 |
| WHSK | full 30 d | rules alone (no gate) | 34 | 0 | 33 | 0 / 33 | -1.8161 | 0.8293 | 1.8161 |
| WHSK | first half | Countersign (fixed gate: half-gap exit) | 126 | 126 | 0 | 0 / 0 | +0.0000 | 0.0000 | 0.0000 |
| WHSK | first half | first gate (full convergence) — the flaw | 116 | 114 | 2 | 0 / 2 | -0.1525 | 0.0520 | 0.1525 |
| WHSK | first half | rules alone (no gate) | 12 | 0 | 12 | 0 / 12 | -0.6828 | 0.3143 | 0.6828 |
| WHSK | second half | Countersign (fixed gate: half-gap exit) | 528 | 526 | 2 | 0 / 2 | -0.0667 | 0.0474 | 0.0667 |
| WHSK | second half | first gate (full convergence) — the flaw | 141 | 129 | 12 | 0 / 12 | -0.6459 | 0.2931 | 0.6459 |
| WHSK | second half | rules alone (no gate) | 22 | 0 | 21 | 0 / 21 | -1.1333 | 0.5150 | 1.1333 |
| WETH | full 30 d | Countersign (fixed gate: half-gap exit) | 2007 | 2003 | 4 | 3 / 1 | +0.0774 | 0.1011 | 0.0148 |
| WETH | full 30 d | first gate (full convergence) — the flaw | 433 | 384 | 49 | 6 / 43 | -1.8042 | 1.2368 | 1.8433 |
| WETH | full 30 d | rules alone (no gate) | 70 | 0 | 69 | 6 / 63 | -2.8062 | 1.7445 | 2.8062 |
| WETH | first half | Countersign (fixed gate: half-gap exit) | 1022 | 1020 | 2 | 1 / 1 | -0.0007 | 0.0518 | 0.0148 |
| WETH | first half | first gate (full convergence) — the flaw | 275 | 255 | 20 | 1 / 19 | -0.8031 | 0.5216 | 0.8031 |
| WETH | first half | rules alone (no gate) | 31 | 0 | 30 | 1 / 29 | -1.3424 | 0.7818 | 1.3424 |
| WETH | second half | Countersign (fixed gate: half-gap exit) | 985 | 983 | 2 | 2 / 0 | +0.0781 | 0.0493 | 0.0000 |
| WETH | second half | first gate (full convergence) — the flaw | 158 | 129 | 29 | 5 / 24 | -1.0011 | 0.7152 | 1.0403 |
| WETH | second half | rules alone (no gate) | 39 | 0 | 38 | 5 / 33 | -1.4087 | 0.9375 | 1.4087 |
| WBTC | full 30 d | Countersign (fixed gate: half-gap exit) | 1588 | 1567 | 20 | 4 / 16 | -0.6415 | 0.4930 | 0.6983 |
| WBTC | full 30 d | first gate (full convergence) — the flaw | 310 | 266 | 43 | 6 / 37 | -1.7167 | 1.0795 | 1.7167 |
| WBTC | full 30 d | rules alone (no gate) | 53 | 0 | 52 | 6 / 46 | -2.3825 | 1.3130 | 2.3825 |
| WBTC | first half | Countersign (fixed gate: half-gap exit) | 996 | 996 | 0 | 0 / 0 | +0.0000 | 0.0000 | 0.0000 |
| WBTC | first half | first gate (full convergence) — the flaw | 250 | 237 | 13 | 2 / 11 | -0.5285 | 0.3394 | 0.5285 |
| WBTC | first half | rules alone (no gate) | 20 | 0 | 20 | 2 / 18 | -1.0842 | 0.5228 | 1.0842 |
| WBTC | second half | Countersign (fixed gate: half-gap exit) | 592 | 571 | 20 | 4 / 16 | -0.6415 | 0.4930 | 0.6983 |
| WBTC | second half | first gate (full convergence) — the flaw | 60 | 29 | 30 | 4 / 26 | -1.1882 | 0.7400 | 1.2451 |
| WBTC | second half | rules alone (no gate) | 33 | 0 | 32 | 4 / 28 | -1.2984 | 0.7903 | 1.3002 |

## Exit reasons (full window, Countersign policy)

- **WHSK**: expiry 2
- **WETH**: expiry 1, target 3
- **WBTC**: target 4, expiry 16

## What the backtest found (and what we fixed)

The first Guardian valued a spread entry as if the gap closed **completely**, while the strategy's own exit target assumes only **half** of it closes. On these 0.30%-fee pools a half-gap exit rarely pays two fees plus ~$0.024 of gas, so the first gate still approved losing trades (it only cut losses vs. no gate). The live Guardian now values every entry at the strategy's own exit (half the gap) after exit fee, impact and gas both ways — the row marked *fixed gate*. The rows marked *the flaw* are kept so the improvement is visible.

## Honest reading

- Nothing was tuned on this data, so there is no in-sample/out-of-sample gap to hide; the two halves are shown to judge stability.
- A small number of round trips cannot establish an edge. We make **no profitability claim**; the backtest shows what the gate does with costs, not that the strategy beats the market.
- Simplifications: last-swap pool price (pools are stale between swaps), a single exchange as reference (live uses the median of 3–4 with outlier rejection), no price impact (≤ 3 bps at 5 USDT, measured live), fills at pool price ± 0.30%.
