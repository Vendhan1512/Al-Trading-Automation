import { priceFromSqrtX96, priceFromTick } from "../common/math.js";
import type { Candle, SwapPoint } from "./fetch.js";

/**
 * Deterministic replay of the LIVE Tier-B rules on historical data. No parameter was tuned on this
 * data: the values below are the live defaults (strategy band, Guardian net-value gate, exits).
 *
 * Honest simplifications (also written in research/backtest.md):
 *  - the pool price at time t is the last swap's price (HSKSwap pools are stale between swaps);
 *  - the reference is ONE exchange (Gate 5m close), the live agent uses the median of 3–4;
 *  - price impact is ignored (≤ 3 bps at 5 USDT on these pools, measured live);
 *  - fills are at the pool price ± the 0.30% fee; gas is charged at 500 gwei.
 */
export interface Params {
  sizeUsdt: number;
  feeBps: number;
  minEdgeBps: number;
  bufferBps: number;
  gasUnitsPerSwap: number;
  gasGwei: number;
  stopLossPct: number;
  expiryHours: number;
  gateOn: boolean; // Guardian expected-net-value gate (false = "rules alone")
  gateMode?: "half-gap" | "full-convergence"; // v1 valued entries at full convergence (the flaw this backtest found)
  dailyLossUsdt: number;
}
export const LIVE_DEFAULTS: Params = {
  sizeUsdt: 5,
  feeBps: 30,
  minEdgeBps: 30,
  bufferBps: 10,
  gasUnitsPerSwap: 300_000,
  gasGwei: 500,
  stopLossPct: 3,
  expiryHours: 6,
  gateOn: true,
  dailyLossUsdt: 1,
};

export interface Trade {
  asset: string;
  entryTs: number;
  exitTs: number;
  entry: number;
  exit: number;
  exitReason: string;
  pnlUsdt: number; // after both fees and both gas legs
}

export interface Result {
  candidates: number;
  refusedByGate: number;
  trades: Trade[];
  netUsdt: number;
  wins: number;
  losses: number;
  maxDrawdownUsdt: number;
  gasUsdt: number;
}

interface Series {
  t: number[];
  dex: number[];
  twap30: number[];
  ref: number[];
}

/** Builds a 5-minute grid of pool price, 30-minute pool TWAP and exchange reference. */
export function buildSeries(swaps: SwapPoint[], candles: Candle[], dec0: number, dec1: number, baseIsToken0: boolean, startTs: number, endTs: number): Series {
  const s: Series = { t: [], dex: [], twap30: [], ref: [] };
  let si = 0;
  let ci = 0;
  let last: SwapPoint | null = null;
  const ticks: { ts: number; tick: number }[] = [];
  for (let t = startTs + 1800; t <= endTs; t += 300) {
    while (si < swaps.length && swaps[si]!.ts <= t) {
      last = swaps[si]!;
      ticks.push({ ts: last.ts, tick: last.tick });
      si++;
    }
    while (ci + 1 < candles.length && candles[ci + 1]!.ts + 300 <= t) ci++;
    const c = candles[ci];
    if (!last || !c || Math.abs(c.ts + 300 - t) > 600) continue;
    const p0 = priceFromSqrtX96(BigInt(last.sqrtPriceX96), dec0, dec1);
    const dex = baseIsToken0 ? p0 : 1 / p0;
    // time-weighted tick over the last 30 minutes (ticks hold between swaps)
    let acc = 0;
    let prev = t - 1800;
    let curTick = [...ticks].reverse().find((x) => x.ts <= t - 1800)?.tick ?? ticks[0]!.tick;
    for (const x of ticks) {
      if (x.ts <= t - 1800 || x.ts > t) continue;
      acc += curTick * (x.ts - prev);
      prev = x.ts;
      curTick = x.tick;
    }
    acc += curTick * (t - prev);
    const tw0 = priceFromTick(acc / 1800, dec0, dec1);
    s.t.push(t);
    s.dex.push(dex);
    s.twap30.push(baseIsToken0 ? tw0 : 1 / tw0);
    s.ref.push(c.close);
  }
  return s;
}

export function replay(asset: string, s: Series, hskUsd: (i: number) => number, p: Params = LIVE_DEFAULTS): Result {
  const fee = p.feeBps / 10_000;
  const band = p.feeBps + p.minEdgeBps + p.bufferBps;
  const res: Result = { candidates: 0, refusedByGate: 0, trades: [], netUsdt: 0, wins: 0, losses: 0, maxDrawdownUsdt: 0, gasUsdt: 0 };
  let pos: { entryIdx: number; qty: number; cost: number; target: number; invalidation: number } | null = null;
  let equity = 0;
  let peak = 0;
  let dayLoss = 0;
  let day = -1;
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i]!;
    const dex = s.dex[i]!;
    const ref = s.ref[i]!;
    const gas = (p.gasUnitsPerSwap * p.gasGwei * 1e-9) * hskUsd(i);
    if (Math.floor(t / 86_400) !== day) {
      day = Math.floor(t / 86_400);
      dayLoss = 0;
    }
    if (pos) {
      const exitValue = pos.qty * dex * (1 - fee);
      let reason = "";
      if (pos.qty * s.twap30[i]! <= pos.cost * (1 - p.stopLossPct / 100)) reason = "stop-loss (TWAP)";
      else if (dex >= pos.target) reason = "target";
      else if (dex <= pos.invalidation) reason = "invalidation";
      else if (t - s.t[pos.entryIdx]! >= p.expiryHours * 3600) reason = "expiry";
      if (reason) {
        const pnl = exitValue - pos.cost - 2 * gas;
        res.trades.push({ asset, entryTs: s.t[pos.entryIdx]!, exitTs: t, entry: pos.cost / pos.qty, exit: dex, exitReason: reason, pnlUsdt: pnl });
        res.gasUsdt += 2 * gas;
        equity += pnl;
        peak = Math.max(peak, equity);
        res.maxDrawdownUsdt = Math.max(res.maxDrawdownUsdt, peak - equity);
        if (pnl > 0) res.wins++;
        else (res.losses++, (dayLoss += -pnl));
        pos = null;
      }
      continue;
    }
    if (dayLoss >= p.dailyLossUsdt) continue;
    const premiumBps = ((dex - ref) / ref) * 10_000;
    if (premiumBps > -band) continue;
    res.candidates++;
    const qty = (p.sizeUsdt * (1 - fee)) / dex;
    // Guardian gate: value at the reference, minus exit fee and gas both ways
    // value at the strategy's own exit target (half the gap), minus exit fee and gas both ways
    const exitAt = p.gateMode === "full-convergence" ? ref : dex + (ref - dex) * 0.5;
    const expectedNet = qty * exitAt - p.sizeUsdt - (qty * exitAt * fee + gas) - gas;
    if (p.gateOn && expectedNet <= 0) {
      res.refusedByGate++;
      continue;
    }
    pos = { entryIdx: i, qty, cost: p.sizeUsdt, target: dex + (ref - dex) * 0.5, invalidation: dex * (1 - Math.max(150, -premiumBps) / 10_000) };
  }
  res.netUsdt = equity;
  return res;
}
