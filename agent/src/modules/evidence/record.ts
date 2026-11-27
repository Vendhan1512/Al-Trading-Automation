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
}

type Payload = {
  filter?: { outcome?: string; reasons?: string[] };
  strategist?: { action?: string; rationale?: string };
  guardian?: { decision?: string; reasons?: string[] } | null;
  risk?: { decision?: string; reasons?: string[] } | null;
};

/** "concentration (100 vs 70): WHSK share…" → "concentration" */
export const checkName = (reason: string) => reason.split(/[\s:(]/)[0] || reason;

export function buildRecord(store: Store, now = Date.now()): TrackRecord {
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
  };
}
