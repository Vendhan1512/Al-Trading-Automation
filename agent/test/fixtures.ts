import type { MarketSnapshot, PoolObservation, ReferenceQuote } from "../src/modules/market-data/types.js";

export const NOW = 1_795_420_000_000; // fixed clock (ms)

export function pool(over: Partial<PoolObservation> = {}): PoolObservation {
  return {
    asset: "WETH",
    pool: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16",
    fee: 3000,
    blockNumber: 30_535_000,
    blockTimestamp: NOW / 1000 - 2,
    spot: 1700,
    twapShort: 1700,
    twapLong: 1699,
    liquidity: "123456789",
    tick: -201844,
    quotes: [
      { sizeUsdt: 2, side: "BUY", amountIn: "2000000", amountOut: "1", effectivePrice: 1705.1, impactBps: 0.2 },
      { sizeUsdt: 2, side: "SELL", amountIn: "1", amountOut: "1", effectivePrice: 1694.9, impactBps: 0.3 },
    ],
    ...over,
  };
}

export function cex(source: string, mid: number, over: Partial<ReferenceQuote> = {}): ReferenceQuote {
  return {
    source,
    asset: "WETH",
    bid: mid * 0.9999,
    ask: mid * 1.0001,
    mid,
    sourceTs: NOW - 1_000,
    fetchedAt: NOW,
    latencyMs: 80,
    kind: "cex",
    ...over,
  };
}

export function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    takenAt: NOW,
    chainId: 177,
    head: { blockNumber: 30_535_000, blockTimestamp: NOW / 1000 - 2, rpcLatencyMs: 120 },
    pools: [pool()],
    references: [cex("gate", 1710), cex("mexc", 1711), cex("coinbase", 1712)],
    flows: [],
    errors: [],
    ...over,
  };
}
