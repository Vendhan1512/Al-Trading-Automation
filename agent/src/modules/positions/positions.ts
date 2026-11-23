import type { NetworkConfig } from "../../config.js";
import type { PredictionRow } from "../../common/store.js";
import type { MarketHealth } from "../data-reliability/engine.js";
import { usdt, type VaultState } from "../vault/state.js";

export type ExitReason = "STOP_LOSS" | "INVALIDATED" | "TAKE_PROFIT" | "EXPIRED";

export interface PositionView {
  asset: string;
  qty: number;
  qtyRaw: bigint;
  costUsdt: number;
  avgEntry: number;
  spot: number;
  exitValueUsdt: number; // executable: spot after pool fee and measured sell impact
  unrealizedPnlUsdt: number;
  unrealizedPct: number;
  prediction: { hash: string; target: number; invalidation: number; expiresAt: number; probability: number } | null;
  exit: { reason: ExitReason; detail: string } | null;
}

export interface ExitParams {
  stopLossPct: number; // hard stop on cost basis, independent of the prediction
}
export const DEFAULT_EXIT: ExitParams = { stopLossPct: 3 };

/**
 * Position Monitoring & Exit Management (Stage 16). Pure. Exit signals never go to the LLM —
 * they go straight to the Guardian's risk-reducing fast path. A stop cannot guarantee a price;
 * the vault's TWAP floor still applies to every exit.
 */
export function evaluatePositions(
  net: NetworkConfig,
  v: VaultState,
  health: MarketHealth,
  predictions: PredictionRow[],
  nowSec: number,
  p: ExitParams = DEFAULT_EXIT,
): PositionView[] {
  return v.positions
    .filter((x) => x.qty > 0n)
    .map((x) => {
      const h = health.assets.find((a) => a.asset === x.asset);
      const pool = net.pools.find((q) => q.asset === x.asset)!;
      const qty = Number(x.qty) / 10 ** x.decimals;
      const costUsdt = usdt(x.cost, v.quoteDecimals);
      const spot = h?.dexSpot ?? NaN;
      const sellImpact = h?.impact.find((i) => i.sizeUsdt >= qty * spot)?.sellBps ?? h?.impact.at(-1)?.sellBps ?? 0;
      const exitValueUsdt = qty * spot * (1 - pool.fee / 1e6) * (1 - Math.max(0, sellImpact ?? 0) / 10_000);
      const unrealizedPnlUsdt = exitValueUsdt - costUsdt;
      const unrealizedPct = costUsdt > 0 ? (unrealizedPnlUsdt / costUsdt) * 100 : 0;
      const pr = predictions
        .filter((q) => q.asset === x.asset && q.direction === "BUY" && q.outcome === null)
        .sort((a, b) => b.created_at - a.created_at)[0];
      const prediction = pr ? { hash: pr.hash, target: pr.target, invalidation: pr.invalidation, expiresAt: pr.expires_at, probability: pr.probability } : null;

      let exit: PositionView["exit"] = null;
      if (Number.isFinite(spot) && h && h.status !== "REJECT") {
        if (unrealizedPct <= -p.stopLossPct) exit = { reason: "STOP_LOSS", detail: `${unrealizedPct.toFixed(2)}% ≤ −${p.stopLossPct}% on cost basis` };
        else if (prediction && spot <= prediction.invalidation) exit = { reason: "INVALIDATED", detail: `spot ${spot.toPrecision(6)} ≤ invalidation ${prediction.invalidation.toPrecision(6)}` };
        else if (prediction && spot >= prediction.target) exit = { reason: "TAKE_PROFIT", detail: `spot ${spot.toPrecision(6)} ≥ target ${prediction.target.toPrecision(6)}` };
        else if (prediction && nowSec >= prediction.expiresAt) exit = { reason: "EXPIRED", detail: `prediction expired at ${new Date(prediction.expiresAt * 1000).toISOString()}` };
      }
      return { asset: x.asset, qty, qtyRaw: x.qty, costUsdt, avgEntry: qty > 0 ? costUsdt / qty : 0, spot, exitValueUsdt, unrealizedPnlUsdt, unrealizedPct, prediction, exit };
    });
}

export interface Resolution {
  hash: string;
  outcome: "HIT" | "INVALIDATED" | "EXPIRED";
  price: number;
}

/** Grades open predictions against the committed levels (sampled each tick; intra-tick wicks can be missed). */
export function gradePredictions(open: PredictionRow[], health: MarketHealth, nowSec: number): Resolution[] {
  const out: Resolution[] = [];
  for (const pr of open) {
    const price = health.assets.find((a) => a.asset === pr.asset)?.dexSpot;
    if (price === undefined || !Number.isFinite(price)) continue;
    const up = pr.direction === "BUY";
    if (up ? price >= pr.target : price <= pr.target) out.push({ hash: pr.hash, outcome: "HIT", price });
    else if (up ? price <= pr.invalidation : price >= pr.invalidation) out.push({ hash: pr.hash, outcome: "INVALIDATED", price });
    else if (nowSec >= pr.expires_at) out.push({ hash: pr.hash, outcome: "EXPIRED", price });
  }
  return out;
}
