import type { Store } from "../../common/store.js";

/**
 * Track record + refusal ledger, computed from the journal (whose entries are Merkle-anchored on-chain)
 * and the trade table (each row re-verifiable with `verify trade`). Refusals are first-class: for every
 * proposal the committee turned down we say WHO refused and WHICH check failed.
 */
export interface RefusalReason {
  check: string;
  by: "Execution Guardian" | "Risk Officer" | "Strategy filter" | "Strategist";
  count: number;
  example: string;
}

export interface TrackRecord {
  at: number;
  decisions: { total: number; ticks: number; proposals: number; refused: number; approved: number; executed: number; waits: number };
  anchors: { count: number; anchoredThrough: number; latestTx: string | null; roots: { idx: number; from: number; to: number; tx: string }[] };
  refusals: RefusalReason[];
  byAsset: { asset: string; proposed: number; refused: number; executed: number }[];
  recentRefusals: { seq: number; at: number; asset: string | null; summary: string; hash: string }[];
  trades: { tradeId: string; at: number; asset: string; side: string; tier: string; amountIn: string; amountOut: string; realizedPnl: string; txHash: string; block: number }[];
  predictions: { total: number; resolved: number; hits: number; brier: number | null };
  /** "Would the refused trades have made money?" One grade per opportunity (same asset, refusals < 15 min apart). */
  counterfactual: {
    graded: number;
    pending: number;
    wouldHaveLost: number;
    pnlAfterCostsUsdt: number; // what taking every refused opportunity would have made (negative = refusals saved this)
    pnlBeforeGasUsdt: number;
    items: { asset: string; at: number; sizeUsdt: number; entry: number; exit: number | null; horizonSec: number; pnlUsdt: number | null; refusals: number }[];
  };
  /** The vault against simply holding what the owner deposited (sold inventory valued at today's pool price). */
  vsHold: { actualUsdt: number; holdUsdt: number; diffUsdt: number; diffPct: number } | null;
}

export interface RecordOpts {
  /** pool fee per asset, as a fraction (0.003 = 0.30%) */
  feeOf?: (asset: string) => number;
  /** round-trip gas in USDT when the Guardian's own estimate is missing */
  gasRoundTripUsdt?: number;
  /** current vault value + pool spots, for the buy-and-hold comparison */
  vault?: { totalUsdt: number; spot: (asset: string) => number | null };
  /** token decimals per asset (WBTC has 8) */
  decimalsOf?: (asset: string) => number;
}

type Cand = { asset: string; side: string; entry: number; horizonSec: number; maxSizeUsdt: number; createdAt: number };

type Payload = {
  filter?: { outcome?: string; reasons?: string[] };
  strategist?: { action?: string; rationale?: string };
  guardian?: { decision?: string; reasons?: string[]; economics?: { gasUsdt?: number } } | null;
  candidate?: Cand;
  risk?: { decision?: string; reasons?: string[] } | null;
};

/** "concentration (100 vs 70): WHSK share…" → "concentration" */
export const checkName = (reason: string) => reason.split(/[\s:(]/)[0] || reason;

/** Record options from the network config + the live vault/market (shared by the API and the snapshot). */
export function recordOpts(
  pools: { asset: string; fee: number; base: { decimals: number } }[],
  vault: { totalUsdt: number; spot: (asset: string) => number | null } | null,
): RecordOpts {
  return {
    feeOf: (a) => (pools.find((p) => p.asset === a)?.fee ?? 3000) / 1e6,
    decimalsOf: (a) => pools.find((p) => p.asset === a)?.base.decimals ?? 18,
    vault: vault ?? undefined,
  };
}

export function buildRecord(store: Store, now = Date.now(), opts: RecordOpts = {}): TrackRecord {
  const feeOf = opts.feeOf ?? (() => 0.003);
  const gasRT = opts.gasRoundTripUsdt ?? 0.025;
  const opps: { c: Cand; gas: number; refusals: number }[] = [];
  const rows = store.allDecisions();
  const reasons = new Map<string, RefusalReason>();
  const bump = (by: RefusalReason["by"], reason: string) => {
    const check = checkName(reason);
    const key = `${by}|${check}`;
    const r = reasons.get(key) ?? { check, by, count: 0, example: reason };
    r.count++;
    reasons.set(key, r);
  };
  const assets = new Map<string, { asset: string; proposed: number; refused: number; executed: number }>();
  const asset = (a: string | null) => {
    const k = a ?? "—";
    if (!assets.has(k)) assets.set(k, { asset: k, proposed: 0, refused: 0, executed: 0 });
    return assets.get(k)!;
  };

  let ticks = 0, proposals = 0, refused = 0, approved = 0, executed = 0, waits = 0;
  const recentRefusals: TrackRecord["recentRefusals"] = [];
  for (const d of rows) {
    if (d.kind === "tick") {
      ticks++;
      continue;
    }
    if (d.kind !== "candidate" && d.kind !== "owner" && d.kind !== "exit") continue;
    proposals++;
    const a = asset(d.asset);
    a.proposed++;
    if (d.outcome === "EXECUTED") {
      executed++;
      approved++;
      a.executed++;
      continue;
    }
    if (d.outcome === "APPROVE") {
      approved++;
      continue;
    }
    if (d.outcome === "WAIT" && /unreachable/i.test(d.summary)) {
      waits++;
      continue;
    }
    let p: Payload = {};
    try {
      p = JSON.parse(d.payload) as Payload;
    } catch {
      /* keep empty */
    }
    let counted = false;
    if (p.filter && p.filter.outcome && p.filter.outcome !== "PASS") for (const r of p.filter.reasons ?? []) (bump("Strategy filter", r), (counted = true));
    if (!counted && p.strategist?.action === "SKIP") (bump("Strategist", p.strategist.rationale ?? "skipped"), (counted = true));
    if (!counted && p.guardian && p.guardian.decision !== "APPROVE") for (const r of p.guardian.reasons ?? []) (bump("Execution Guardian", r), (counted = true));
    if (!counted && p.risk && p.risk.decision !== "APPROVE") for (const r of p.risk.reasons ?? []) (bump("Risk Officer", r), (counted = true));
    const c = p.candidate;
    if (c && c.side === "BUY" && Number.isFinite(c.entry) && c.entry > 0 && d.outcome !== "WAIT") {
      let last: (typeof opps)[number] | undefined;
      for (let k = opps.length - 1; k >= 0 && !last; k--) if (opps[k]!.c.asset === c.asset) last = opps[k];
      if (last && c.createdAt - last.c.createdAt < 15 * 60_000) last.refusals++;
      else opps.push({ c, gas: p.guardian?.economics?.gasUsdt ? p.guardian.economics.gasUsdt * 2 : gasRT, refusals: 1 });
    }
    if (d.outcome === "WAIT") waits++;
    else refused++;
    a.refused++;
    recentRefusals.push({ seq: d.seq, at: d.at, asset: d.asset, summary: d.summary, hash: d.hash });
  }

  const anchors = store.allAnchors();
  const preds = store.predictions();
  const resolved = preds.filter((p) => p.outcome !== null);
  const hits = resolved.filter((p) => p.outcome === "HIT").length;
  const brier = resolved.length ? resolved.reduce((s, p) => s + (p.probability - (p.outcome === "HIT" ? 1 : 0)) ** 2, 0) / resolved.length : null;

  // counterfactual: buy at the proposal's entry, sell at the pool price when its own horizon ends
  const series = new Map<string, { t: number; dex: number }[]>();
  const seriesOf = (a: string) => {
    if (!series.has(a)) series.set(a, store.history(a, 100_000).filter((x) => Number.isFinite(x.dex)).sort((x, y) => x.t - y.t));
    return series.get(a)!;
  };
  let pnlAfter = 0, pnlBefore = 0, graded = 0, pending = 0, lost = 0;
  const items: TrackRecord["counterfactual"]["items"] = [];
  for (const o of opps) {
    const due = o.c.createdAt + o.c.horizonSec * 1000;
    const pt = due <= now ? seriesOf(o.c.asset).find((x) => x.t >= due) : undefined;
    if (!pt) {
      pending++;
      items.push({ asset: o.c.asset, at: o.c.createdAt, sizeUsdt: o.c.maxSizeUsdt, entry: o.c.entry, exit: null, horizonSec: o.c.horizonSec, pnlUsdt: null, refusals: o.refusals });
      continue;
    }
    const f = feeOf(o.c.asset);
    const gross = o.c.maxSizeUsdt * ((pt.dex / o.c.entry) * (1 - f) * (1 - f) - 1);
    const net = gross - o.gas;
    graded++;
    pnlBefore += gross;
    pnlAfter += net;
    if (net < 0) lost++;
    items.push({ asset: o.c.asset, at: o.c.createdAt, sizeUsdt: o.c.maxSizeUsdt, entry: o.c.entry, exit: pt.dex, horizonSec: o.c.horizonSec, pnlUsdt: net, refusals: o.refusals });
  }

  // buy-and-hold: add back what was sold, valued at today's pool price, minus what the sales brought in
  let vsHold: TrackRecord["vsHold"] = null;
  if (opts.vault) {
    let adj = 0;
    let ok = true;
    for (const t of store.trades()) {
      const spot = opts.vault.spot(t.asset);
      if (spot === null) { ok = false; break; }
      const bd = 10 ** (opts.decimalsOf?.(t.asset) ?? 18);
      if (t.side === "SELL") adj += (Number(t.amount_in) / bd) * spot - Number(t.amount_out) / 1e6;
      else adj += Number(t.amount_in) / 1e6 - (Number(t.amount_out) / bd) * spot;
    }
    if (ok) {
      const hold = opts.vault.totalUsdt + adj;
      vsHold = { actualUsdt: opts.vault.totalUsdt, holdUsdt: hold, diffUsdt: opts.vault.totalUsdt - hold, diffPct: hold > 0 ? ((opts.vault.totalUsdt - hold) / hold) * 100 : 0 };
    }
  }

  return {
    at: now,
    decisions: { total: rows.length, ticks, proposals, refused, approved, executed, waits },
    anchors: {
      count: anchors.length,
      anchoredThrough: anchors.at(-1)?.local_to ?? 0,
      latestTx: anchors.at(-1)?.tx ?? null,
      roots: anchors.map((x) => ({ idx: x.idx, from: x.local_from, to: x.local_to, tx: x.tx })),
    },
    refusals: [...reasons.values()].sort((x, y) => y.count - x.count),
    byAsset: [...assets.values()].filter((x) => x.asset !== "—").sort((x, y) => y.proposed - x.proposed),
    recentRefusals: recentRefusals.slice(-12).reverse(),
    trades: store.trades().map((t) => ({ tradeId: t.trade_id, at: t.at, asset: t.asset, side: t.side, tier: t.tier, amountIn: t.amount_in, amountOut: t.amount_out, realizedPnl: t.realized_pnl, txHash: t.tx_hash, block: t.block })),
    predictions: { total: preds.length, resolved: resolved.length, hits, brier },
    counterfactual: { graded, pending, wouldHaveLost: lost, pnlAfterCostsUsdt: pnlAfter, pnlBeforeGasUsdt: pnlBefore, items: items.slice(-20).reverse() },
    vsHold,
  };
}
