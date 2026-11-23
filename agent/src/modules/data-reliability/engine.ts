import type { AssetSymbol, ReliabilityPolicy } from "../../config.js";
import { DEFAULT_POLICY } from "../../config.js";
import { bps, median } from "../../common/math.js";
import type { MarketSnapshot, PoolObservation, ReferenceQuote } from "../market-data/types.js";

/**
 * Data Reliability Engine — decides whether market data is trustworthy enough to act on.
 * Deterministic and side-effect free. Statuses are ordered VALID < WARNING < WAIT < REJECT and an
 * asset's status is the worst status any rule produced. Only VALID/WARNING data may feed a trade.
 */
export type Status = "VALID" | "WARNING" | "WAIT" | "REJECT";
const RANK: Record<Status, number> = { VALID: 0, WARNING: 1, WAIT: 2, REJECT: 3 };
export const worst = (...s: Status[]): Status => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "VALID");

export interface Finding {
  status: Status;
  code: string;
  message: string;
}

export interface SourceVerdict {
  source: string;
  kind: "cex" | "oracle";
  mid: number;
  spreadBps: number | null;
  ageSec: number | null;
  deviationBps: number | null;
  accepted: boolean;
  reason?: string;
}

export interface AssetHealth {
  asset: AssetSymbol;
  status: Status;
  findings: Finding[];
  dexSpot: number;
  twapShort: number;
  twapLong: number;
  spotVsTwapBps: number;
  reference: number | null; // median of accepted CEX mids
  premiumBps: number | null; // DEX spot vs reference (+ = pool rich, − = pool cheap)
  sources: SourceVerdict[];
  impact: { sizeUsdt: number; buyBps: number | null; sellBps: number | null }[];
}

export interface MarketHealth {
  evaluatedAt: number;
  status: Status;
  chain: { status: Status; findings: Finding[]; blockNumber: number | null; blockAgeSec: number | null };
  assets: AssetHealth[];
}

function evaluateSources(refs: ReferenceQuote[], now: number, policy: ReliabilityPolicy): SourceVerdict[] {
  const verdicts: SourceVerdict[] = refs
    .filter((r) => r.kind === "cex")
    .map((r) => {
      const ageSec = r.sourceTs !== null ? Math.max(0, (now - r.sourceTs) / 1000) : null;
      const spreadBps = r.bid !== null && r.ask !== null && r.bid > 0 ? ((r.ask - r.bid) / r.bid) * 10_000 : null;
      const v: SourceVerdict = { source: r.source, kind: "cex", mid: r.mid, spreadBps, ageSec, deviationBps: null, accepted: false };
      if (r.error) v.reason = `unavailable: ${r.error}`;
      else if (!Number.isFinite(r.mid) || r.mid <= 0) v.reason = "no valid price";
      else if (spreadBps !== null && spreadBps < 0) v.reason = "crossed book (bid > ask)";
      else if (spreadBps !== null && spreadBps > policy.maxRefSpreadBps)
        v.reason = `book too wide (${spreadBps.toFixed(0)} bps > ${policy.maxRefSpreadBps})`;
      else if (ageSec !== null && ageSec > policy.maxRefAgeSec)
        v.reason = `stale quote (${ageSec.toFixed(0)} s old > ${policy.maxRefAgeSec} s)`;
      else v.accepted = true;
      return v;
    });

  // Outlier rejection against the median of the surviving candidates (single pass, robust to 1 bad source).
  const m = median(verdicts.filter((v) => v.accepted).map((v) => v.mid));
  if (Number.isFinite(m)) {
    for (const v of verdicts) {
      if (!Number.isFinite(v.mid)) continue;
      v.deviationBps = bps(v.mid, m);
      if (v.accepted && Math.abs(v.deviationBps) > policy.maxRefDeviationBps) {
        v.accepted = false;
        v.reason = `outlier (${v.deviationBps.toFixed(0)} bps from median)`;
      }
    }
  }
  return verdicts;
}

function evaluateAsset(
  pool: PoolObservation | undefined,
  asset: AssetSymbol,
  refs: ReferenceQuote[],
  now: number,
  policy: ReliabilityPolicy,
  oracleHeartbeatSec: number,
): AssetHealth {
  const findings: Finding[] = [];
  const add = (status: Status, code: string, message: string) => findings.push({ status, code, message });

  const dexSpot = pool?.spot ?? NaN;
  const twapShort = pool?.twapShort ?? NaN;
  const twapLong = pool?.twapLong ?? NaN;
  if (!pool) add("REJECT", "POOL_MISSING", "pool was not observed");
  else if (pool.error) add("REJECT", "POOL_READ_FAILED", `pool read failed: ${pool.error}`);
  else if (pool.liquidity === "0") add("REJECT", "NO_LIQUIDITY", "pool has no in-range liquidity");

  let spotVsTwapBps = NaN;
  if (Number.isFinite(dexSpot) && Number.isFinite(twapShort)) {
    spotVsTwapBps = bps(dexSpot, twapShort);
    const a = Math.abs(spotVsTwapBps);
    if (a >= policy.spotVsTwapRejectBps)
      add("REJECT", "SPOT_SPIKE", `spot is ${spotVsTwapBps.toFixed(0)} bps from the 5-min TWAP (possible manipulation)`);
    else if (a >= policy.spotVsTwapWarnBps)
      add("WARNING", "SPOT_MOVING", `spot is ${spotVsTwapBps.toFixed(0)} bps from the 5-min TWAP`);
  }

  const assetRefs = refs.filter((r) => r.asset === asset);
  const sources = evaluateSources(assetRefs, now, policy);
  const accepted = sources.filter((s) => s.accepted);
  const reference = accepted.length ? median(accepted.map((s) => s.mid)) : null;
  if (accepted.length === 0) add("WAIT", "NO_RELIABLE_REFERENCE", "no exchange reference passed the freshness/spread/outlier checks");
  else if (accepted.length < policy.minFreshRefs)
    add("WARNING", "SINGLE_REFERENCE", `only ${accepted.length} reliable reference (need ${policy.minFreshRefs})`);
  for (const s of sources.filter((x) => !x.accepted)) add("VALID", "SOURCE_EXCLUDED", `${s.source} excluded: ${s.reason}`);

  let premiumBps: number | null = null;
  if (reference !== null && Number.isFinite(dexSpot)) {
    premiumBps = bps(dexSpot, reference);
    if (Math.abs(premiumBps) > policy.maxPlausiblePremiumBps)
      add("REJECT", "IMPLAUSIBLE_GAP", `DEX vs reference gap of ${premiumBps.toFixed(0)} bps is implausible — treating as bad data`);
  }

  // Oracle: a sanity check only, never the execution price. Stale prints are excluded, not trusted.
  for (const o of assetRefs.filter((r) => r.kind === "oracle")) {
    const ageSec = o.sourceTs !== null ? (now - o.sourceTs) / 1000 : null;
    const v: SourceVerdict = { source: o.source, kind: "oracle", mid: o.mid, spreadBps: null, ageSec, deviationBps: null, accepted: false };
    if (o.error || !Number.isFinite(o.mid)) v.reason = `unavailable${o.error ? `: ${o.error}` : ""}`;
    else if (ageSec === null || ageSec > oracleHeartbeatSec) v.reason = `stale (${ageSec?.toFixed(0)} s > heartbeat ${oracleHeartbeatSec} s)`;
    else {
      v.accepted = true;
      if (reference !== null) {
        v.deviationBps = bps(o.mid, reference);
        if (Math.abs(v.deviationBps) > policy.oracleWarnBps)
          add("WARNING", "ORACLE_DISAGREES", `${o.source} is ${v.deviationBps.toFixed(0)} bps from the exchange median`);
      }
    }
    sources.push(v);
  }

  const sizes = [...new Set(pool?.quotes.map((q) => q.sizeUsdt) ?? [])];
  const impact = sizes.map((s) => ({
    sizeUsdt: s,
    buyBps: pool?.quotes.find((q) => q.sizeUsdt === s && q.side === "BUY")?.impactBps ?? null,
    sellBps: pool?.quotes.find((q) => q.sizeUsdt === s && q.side === "SELL")?.impactBps ?? null,
  }));

  return {
    asset,
    status: worst(...findings.map((f) => f.status)),
    findings,
    dexSpot,
    twapShort,
    twapLong,
    spotVsTwapBps,
    reference,
    premiumBps,
    sources,
    impact,
  };
}

export function evaluateMarket(
  snap: MarketSnapshot,
  assets: AssetSymbol[],
  opts: { now?: number; policy?: ReliabilityPolicy; oracleHeartbeatSec?: number } = {},
): MarketHealth {
  const now = opts.now ?? Date.now();
  const policy = opts.policy ?? DEFAULT_POLICY;
  const chainFindings: Finding[] = [];
  let blockAgeSec: number | null = null;
  if (!snap.head) {
    chainFindings.push({ status: "REJECT", code: "RPC_UNAVAILABLE", message: "blockchain RPC unavailable — new trades blocked" });
  } else {
    blockAgeSec = Math.max(0, now / 1000 - snap.head.blockTimestamp);
    if (blockAgeSec > policy.rejectBlockAgeSec)
      chainFindings.push({ status: "REJECT", code: "CHAIN_STALLED", message: `latest block is ${blockAgeSec.toFixed(0)} s old` });
    else if (blockAgeSec > policy.maxBlockAgeSec)
      chainFindings.push({ status: "WAIT", code: "CHAIN_LAGGING", message: `latest block is ${blockAgeSec.toFixed(0)} s old` });
  }
  const chainStatus = worst(...chainFindings.map((f) => f.status));

  const assetHealth = assets.map((a) => {
    const h = evaluateAsset(
      snap.pools.find((p) => p.asset === a),
      a,
      snap.references,
      now,
      policy,
      opts.oracleHeartbeatSec ?? 25 * 3600,
    );
    // chain problems cap every asset: no fresh chain state => no trading on that asset
    if (chainStatus !== "VALID") {
      h.findings.unshift(...chainFindings);
      h.status = worst(h.status, chainStatus);
    }
    return h;
  });

  return {
    evaluatedAt: now,
    status: worst(chainStatus, ...assetHealth.map((h) => h.status)),
    chain: { status: chainStatus, findings: chainFindings, blockNumber: snap.head?.blockNumber ?? null, blockAgeSec },
    assets: assetHealth,
  };
}

/** True if this asset's data is good enough to propose a trade on. */
export const isTradable = (h: AssetHealth) => h.status === "VALID" || h.status === "WARNING";
