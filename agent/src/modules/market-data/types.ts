import type { AssetSymbol } from "../../config.js";

/** One executable quote at a given size (from QuoterV2 — an eth_call, nothing is sent). */
export interface QuotePoint {
  sizeUsdt: number;
  side: "BUY" | "SELL"; // BUY = USDT -> asset, SELL = asset -> USDT
  amountIn: string; // raw units
  amountOut: string; // raw units
  effectivePrice: number; // USDT per asset, after fee and impact
  impactBps: number; // vs pool spot, fee excluded
}

export interface PoolObservation {
  asset: AssetSymbol;
  pool: string;
  fee: number;
  blockNumber: number;
  blockTimestamp: number;
  spot: number; // USDT per asset
  twapShort: number;
  twapLong: number;
  liquidity: string;
  tick: number;
  quotes: QuotePoint[];
  error?: string;
}

export interface ReferenceQuote {
  source: string; // e.g. "gate", "mexc", "hashkey", "coinbase", "apro"
  asset: AssetSymbol;
  bid: number | null;
  ask: number | null;
  mid: number;
  sourceTs: number | null; // ms epoch reported by the source, if any
  fetchedAt: number; // ms epoch
  latencyMs: number;
  kind: "cex" | "oracle";
  error?: string;
}

export interface FlowStats {
  asset: AssetSymbol;
  fromBlock: number;
  toBlock: number;
  swaps: number;
  buyVolumeUsdt: number; // USDT paid into the pool (asset bought)
  sellVolumeUsdt: number; // USDT taken out of the pool (asset sold)
  netFlowUsdt: number; // buy - sell
  lastSwapTs: number | null;
}

export interface MarketSnapshot {
  takenAt: number; // ms epoch
  chainId: number;
  head: { blockNumber: number; blockTimestamp: number; rpcLatencyMs: number } | null;
  pools: PoolObservation[];
  references: ReferenceQuote[];
  flows: FlowStats[];
  errors: string[];
}
