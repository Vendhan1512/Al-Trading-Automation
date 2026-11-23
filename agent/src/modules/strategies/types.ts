import type { AssetSymbol } from "../../config.js";
import type { TierName } from "../vault/state.js";

/**
 * A deterministic trade candidate. Every number here is computed by rules from observed market
 * data — the AI Strategist may only choose, shrink or skip a candidate; it never creates one.
 */
export interface Candidate {
  id: string;
  tier: TierName;
  strategyId: "arb-cycle" | "spread-reversion" | "twap-mean-reversion";
  asset: AssetSymbol;
  side: "BUY" | "SELL";
  /** upper bound in USDT (BUY: USDT in; SELL: USDT value of the asset sold) */
  maxSizeUsdt: number;
  createdAt: number;
  expiresAt: number;
  entry: number; // DEX spot, USDT per asset
  target: number;
  invalidation: number;
  horizonSec: number;
  grossEdgeBps: number; // before costs
  evidence: {
    dexSpot: number;
    reference: number | null;
    premiumBps: number | null;
    spotVsTwapBps: number;
    impactBps: number | null;
    zScore?: number;
    bandBps?: number;
  };
  thesis: string; // deterministic, human-readable
}

export interface CycleScan {
  scannedAt: number;
  pools: number;
  cycles: number; // distinct-pool cycles that start and end in the quote token
  best: { path: string; netBps: number } | null;
  note: string;
}
