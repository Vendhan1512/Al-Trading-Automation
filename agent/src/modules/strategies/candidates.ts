import { keccak256, toHex } from "viem";
import type { AssetSymbol, NetworkConfig, PoolInfo } from "../../config.js";
import type { AssetHealth, MarketHealth } from "../data-reliability/engine.js";
import { isTradable } from "../data-reliability/engine.js";
import { tierBit, usdt, type VaultState } from "../vault/state.js";
import type { Candidate, CycleScan } from "./types.js";

export interface StrategyParams {
  minTradeUsdt: number; // dust floor
  safetyBufferBps: number; // added to every entry band
  tierCZ: number; // |z| threshold for mean reversion
  tierCMinPoints: number; // history needed for a z-score
  tierCSizeFraction: number; // directional trades are sized smaller
  signalTtlSec: number;
  spreadHorizonSec: number;
}

export const DEFAULT_STRATEGY: StrategyParams = {
  minTradeUsdt: 0.1,
  safetyBufferBps: 10,
  tierCZ: 2,
  tierCMinPoints: 30,
  tierCSizeFraction: 0.5,
  signalTtlSec: 90,
  spreadHorizonSec: 6 * 3600,
};

const feeBps = (p: PoolInfo) => p.fee / 100; // 3000 -> 30 bps per leg

/** Size headroom in USDT for a new ENTRY given the mandate and current state. */
export function entryHeadroomUsdt(v: VaultState, asset: AssetSymbol): number {
  const d = v.quoteDecimals;
  const m = v.mandate;
  const pos = v.positions.find((p) => p.asset === asset);
  const byCap = usdt(m.maxTradeQuote, d);
  const byVolume = usdt(m.dailyVolumeQuote - v.dayVolume, d);
  const byExposure = usdt(m.maxExposureQuote - (pos?.cost ?? 0n), d);
  const byCash = usdt(v.quoteBalance, d);
  return Math.max(0, Math.min(byCap, byVolume, byExposure, byCash));
}

function cid(parts: unknown[]): string {
  return keccak256(toHex(JSON.stringify(parts))).slice(0, 18);
}

function impactAt(h: AssetHealth, side: "BUY" | "SELL", size: number): number | null {
  const pts = h.impact.filter((i) => (side === "BUY" ? i.buyBps : i.sellBps) !== null);
  if (!pts.length) return null;
  const at = pts.find((i) => i.sizeUsdt >= size) ?? pts[pts.length - 1]!;
  return side === "BUY" ? at.buyBps : at.sellBps;
}

/** Tier B — spread reversion: trade the pool against a reliable exchange reference. */
export function spreadCandidates(
  net: NetworkConfig,
  health: MarketHealth,
  v: VaultState,
  now: number,
  sp: StrategyParams = DEFAULT_STRATEGY,
): Candidate[] {
  if (!(v.mandate.tiersMask & tierBit("B"))) return [];
  const out: Candidate[] = [];
  for (const h of health.assets) {
    const pool = net.pools.find((p) => p.asset === h.asset)!;
    if (!isTradable(h) || h.reference === null || h.premiumBps === null) continue;
    const pos = v.positions.find((p) => p.asset === h.asset);
    const posValueUsdt = pos ? (Number(pos.qty) / 10 ** pos.decimals) * h.dexSpot : 0;

    // BUY when the pool is cheap by more than: one pool fee + impact + mandate edge + buffer
    const buySize = entryHeadroomUsdt(v, h.asset);
    const buyImpact = impactAt(h, "BUY", buySize) ?? 0;
    const buyBand = feeBps(pool) + Math.max(0, buyImpact) + v.mandate.minEdgeBps + sp.safetyBufferBps;
    if (buySize >= sp.minTradeUsdt && h.premiumBps <= -buyBand) {
      const gap = h.reference - h.dexSpot;
      out.push({
        id: cid(["B", h.asset, "BUY", now]),
        tier: "B",
        strategyId: "spread-reversion",
        asset: h.asset,
        side: "BUY",
        maxSizeUsdt: buySize,
        createdAt: now,
        expiresAt: now + sp.signalTtlSec * 1000,
        entry: h.dexSpot,
        target: h.dexSpot + gap * 0.5, // honest: assume only half the gap closes on the pool
        invalidation: h.dexSpot * (1 - Math.max(150, -h.premiumBps) / 10_000),
        horizonSec: sp.spreadHorizonSec,
        grossEdgeBps: -h.premiumBps - feeBps(pool) - Math.max(0, buyImpact),
        evidence: { dexSpot: h.dexSpot, reference: h.reference, premiumBps: h.premiumBps, spotVsTwapBps: h.spotVsTwapBps, impactBps: buyImpact, bandBps: buyBand },
        thesis: `${h.asset} pool is ${(-h.premiumBps).toFixed(0)} bps below the exchange median (${h.reference.toPrecision(6)}); entry band ${buyBand.toFixed(0)} bps.`,
      });
    }

    // SELL tracked inventory when the pool is rich by more than the same band
    const sellSize = posValueUsdt; // exits of tracked inventory are not capped by the vault
    const sellImpact = impactAt(h, "SELL", sellSize) ?? 0;
    const sellBand = feeBps(pool) + Math.max(0, sellImpact) + v.mandate.minEdgeBps + sp.safetyBufferBps;
    if (sellSize >= sp.minTradeUsdt && h.premiumBps >= sellBand) {
      out.push({
        id: cid(["B", h.asset, "SELL", now]),
        tier: "B",
        strategyId: "spread-reversion",
        asset: h.asset,
        side: "SELL",
        maxSizeUsdt: sellSize,
        createdAt: now,
        expiresAt: now + sp.signalTtlSec * 1000,
        entry: h.dexSpot,
        target: h.dexSpot - (h.dexSpot - h.reference) * 0.5,
        invalidation: h.dexSpot * (1 + Math.max(150, h.premiumBps) / 10_000),
        horizonSec: sp.spreadHorizonSec,
        grossEdgeBps: h.premiumBps - feeBps(pool) - Math.max(0, sellImpact),
        evidence: { dexSpot: h.dexSpot, reference: h.reference, premiumBps: h.premiumBps, spotVsTwapBps: h.spotVsTwapBps, impactBps: sellImpact, bandBps: sellBand },
        thesis: `${h.asset} pool is ${h.premiumBps.toFixed(0)} bps above the exchange median; selling held inventory.`,
      });
    }
  }
  return out;
}

export function zScore(series: number[]): { z: number; mean: number; sd: number } | null {
  if (series.length < 3) return null;
  const last = series[series.length - 1]!;
  const hist = series.slice(0, -1);
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  if (!(sd > 0)) return null;
  return { z: (last - mean) / sd, mean, sd };
}

/** Tier C — directional mean reversion of the pool price against its own recent history. */
export function meanReversionCandidates(
  net: NetworkConfig,
  health: MarketHealth,
  v: VaultState,
  history: (asset: AssetSymbol) => number[],
  now: number,
  sp: StrategyParams = DEFAULT_STRATEGY,
): Candidate[] {
  if (!(v.mandate.tiersMask & tierBit("C"))) return [];
  const out: Candidate[] = [];
  for (const h of health.assets) {
    if (!isTradable(h)) continue;
    const series = history(h.asset).filter(Number.isFinite);
    if (series.length < sp.tierCMinPoints) continue;
    const zs = zScore(series);
    if (!zs || zs.z > -sp.tierCZ) continue; // long-only vault: only oversold entries
    if (h.premiumBps !== null && h.premiumBps > 0) continue; // never buy a pool that is rich vs the market
    const pool = net.pools.find((p) => p.asset === h.asset)!;
    const size = entryHeadroomUsdt(v, h.asset) * sp.tierCSizeFraction;
    if (size < sp.minTradeUsdt) continue;
    const impact = impactAt(h, "BUY", size) ?? 0;
    out.push({
      id: cid(["C", h.asset, "BUY", now]),
      tier: "C",
      strategyId: "twap-mean-reversion",
      asset: h.asset,
      side: "BUY",
      maxSizeUsdt: size,
      createdAt: now,
      expiresAt: now + sp.signalTtlSec * 1000,
      entry: h.dexSpot,
      target: zs.mean,
      invalidation: h.dexSpot - 1.5 * zs.sd,
      horizonSec: 2 * 3600,
      grossEdgeBps: ((zs.mean - h.dexSpot) / h.dexSpot) * 10_000 - feeBps(pool) - Math.max(0, impact),
      evidence: { dexSpot: h.dexSpot, reference: h.reference, premiumBps: h.premiumBps, spotVsTwapBps: h.spotVsTwapBps, impactBps: impact, zScore: zs.z },
      thesis: `${h.asset} pool is ${zs.z.toFixed(2)}σ below its recent mean ${zs.mean.toPrecision(6)}.`,
    });
  }
  return out;
}

/**
 * Tier A — scan for quote→…→quote cycles through DISTINCT pools. Same-pool round trips are
 * excluded because they always lose two fees. On today's HSKSwap (a star around USDT) this
 * honestly reports zero cycles; the scanner picks up new pools automatically when added to config.
 */
export function scanCycles(net: NetworkConfig, now: number): CycleScan {
  const q = net.quote.address.toLowerCase();
  const edges = net.pools.map((p) => [p.base.address.toLowerCase(), p.quote.address.toLowerCase(), p.address] as const);
  const cycles: string[] = [];
  const walk = (node: string, used: Set<string>, path: string[]) => {
    if (path.length > 1 && node === q) {
      cycles.push(path.join(">"));
      return;
    }
    if (used.size >= 4) return;
    for (const [a, b, pool] of edges) {
      if (used.has(pool)) continue;
      const next = a === node ? b : b === node ? a : null;
      if (!next) continue;
      walk(next, new Set([...used, pool]), [...path, pool]);
    }
  };
  walk(q, new Set(), [q]);
  return {
    scannedAt: now,
    pools: net.pools.length,
    cycles: cycles.length,
    best: null,
    note: cycles.length
      ? `${cycles.length} candidate cycles found — quoting required`
      : "no distinct-pool cycle exists (every pool pairs with USDT); Tier A dormant",
  };
}
