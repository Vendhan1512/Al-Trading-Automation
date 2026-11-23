import type { PredictionRow, TradeRow, TxRow } from "../../common/store.js";

export interface StrategyMetrics {
  trades: number;
  closedTrades: number; // sells / exits (realized)
  wins: number;
  losses: number;
  winRatePct: number | null;
  realizedPnlUsdt: number;
  gasUsdt: number;
  netPnlUsdt: number; // realized − gas (gas is not in the vault's cost basis)
  maxDrawdownUsdt: number;
  consecutiveLosses: number;
  avgExpectedNetUsdt: number | null; // Guardian's committed expectation at entry
  predictions: { total: number; resolved: number; hits: number; brier: number | null; accuracyPct: number | null };
  tx: { total: number; failed: number; failureRatePct: number | null };
  byTier: Record<string, { trades: number; realizedPnlUsdt: number }>;
}

/**
 * Strategy Health Monitor (Stage 17). Prediction calibration (Brier) is kept SEPARATE from
 * trading profitability — accurate predictions can still lose money after costs.
 */
export function computeMetrics(trades: TradeRow[], preds: PredictionRow[], txs: TxRow[], hskUsd: number, quoteDecimals = 6): StrategyMetrics {
  const q = (x: string) => Number(x) / 10 ** quoteDecimals;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let consec = 0;
  let wins = 0;
  let losses = 0;
  let realized = 0;
  let gas = 0;
  const byTier: StrategyMetrics["byTier"] = {};
  for (const t of trades) {
    const r = q(t.realized_pnl);
    const g = (Number(t.gas_used) * Number(t.gas_price)) / 1e18 * hskUsd;
    realized += r;
    gas += g;
    equity += r - g;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    byTier[t.tier] = { trades: (byTier[t.tier]?.trades ?? 0) + 1, realizedPnlUsdt: (byTier[t.tier]?.realizedPnlUsdt ?? 0) + r };
    if (t.side === "SELL" || t.tier === "A") {
      if (r > 0) {
        wins++;
        consec = 0;
      } else {
        losses++;
        consec++;
      }
    }
  }
  const closed = wins + losses;
  const entries = trades.filter((t) => t.side === "BUY");
  const resolved = preds.filter((p) => p.outcome !== null);
  const hits = resolved.filter((p) => p.outcome === "HIT").length;
  const brier = resolved.length ? resolved.reduce((a, p) => a + (p.probability - (p.outcome === "HIT" ? 1 : 0)) ** 2, 0) / resolved.length : null;
  const failed = txs.filter((t) => ["REVERTED", "DROPPED", "FAILED"].includes(t.status)).length;
  return {
    trades: trades.length,
    closedTrades: closed,
    wins,
    losses,
    winRatePct: closed ? (wins / closed) * 100 : null,
    realizedPnlUsdt: realized,
    gasUsdt: gas,
    netPnlUsdt: realized - gas,
    maxDrawdownUsdt: maxDd,
    consecutiveLosses: consec,
    avgExpectedNetUsdt: entries.length ? entries.reduce((a, t) => a + q(t.expected_net), 0) / entries.length : null,
    predictions: { total: preds.length, resolved: resolved.length, hits, brier, accuracyPct: resolved.length ? (hits / resolved.length) * 100 : null },
    tx: { total: txs.length, failed, failureRatePct: txs.length ? (failed / txs.length) * 100 : null },
    byTier,
  };
}

export interface BreakerPolicy {
  maxConsecutiveLosses: number;
  maxDrawdownUsdt: number;
  maxFailureRatePct: number;
  minTxForFailureRule: number;
  maxBrier: number; // worse than this => stop directional (tier C) trading
  minResolvedForBrier: number;
}
export const DEFAULT_BREAKER: BreakerPolicy = {
  maxConsecutiveLosses: 3,
  maxDrawdownUsdt: 1,
  maxFailureRatePct: 50,
  minTxForFailureRule: 4,
  maxBrier: 0.3,
  minResolvedForBrier: 8,
};

export type BreakerAction = { kind: "PAUSE"; reason: string } | { kind: "DISABLE_TIER_C"; reason: string };

/** Circuit breaker — the agent itself may pause or tighten its own vault (never loosen, never unpause). */
export function circuitBreaker(m: StrategyMetrics, p: BreakerPolicy = DEFAULT_BREAKER): BreakerAction[] {
  const a: BreakerAction[] = [];
  if (m.consecutiveLosses >= p.maxConsecutiveLosses) a.push({ kind: "PAUSE", reason: `${m.consecutiveLosses} consecutive losing exits` });
  if (m.maxDrawdownUsdt >= p.maxDrawdownUsdt) a.push({ kind: "PAUSE", reason: `drawdown ${m.maxDrawdownUsdt.toFixed(4)} USDT ≥ ${p.maxDrawdownUsdt}` });
  if (m.tx.total >= p.minTxForFailureRule && (m.tx.failureRatePct ?? 0) >= p.maxFailureRatePct)
    a.push({ kind: "PAUSE", reason: `transaction failure rate ${m.tx.failureRatePct!.toFixed(0)}%` });
  if (m.predictions.resolved >= p.minResolvedForBrier && (m.predictions.brier ?? 0) > p.maxBrier)
    a.push({ kind: "DISABLE_TIER_C", reason: `Brier ${m.predictions.brier!.toFixed(3)} > ${p.maxBrier}: directional predictions are not calibrated` });
  return a;
}
