import * as React from "react";
import { motion } from "motion/react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { endpoints } from "@/lib/api";
import { ago, short } from "@/lib/format";
import { cn } from "@/lib/utils";

type Party = "Execution Guardian" | "Risk Officer" | "Strategy filter" | "Strategist";
type TrackRecord = {
  at: number;
  decisions: { total: number; ticks: number; proposals: number; refused: number; approved: number; executed: number; waits: number };
  anchors: { count: number; anchoredThrough: number; latestTx: string | null; roots: { idx: number; from: number; to: number; tx: string }[] };
  refusals: { check: string; by: Party; count: number; example: string }[];
  byAsset: { asset: string; proposed: number; refused: number; executed: number }[];
  recentRefusals: { seq: number; at: number; asset: string | null; summary: string; hash: string }[];
  trades: { tradeId: string; at: number; asset: string; side: string; tier: string; amountIn: string; amountOut: string; realizedPnl: string; txHash: string; block: number }[];
  counterfactual?: {
    graded: number; pending: number; wouldHaveLost: number; pnlAfterCostsUsdt: number; pnlBeforeGasUsdt: number;
    items: { asset: string; at: number; sizeUsdt: number; entry: number; exit: number | null; horizonSec: number; pnlUsdt: number | null; refusals: number }[];
  };
  vsHold?: { actualUsdt: number; holdUsdt: number; diffUsdt: number; diffPct: number } | null;
};

const until = (t: number) => {
  const m = Math.max(0, (t - Date.now()) / 60_000);
  return m < 1 ? "now" : m < 60 ? `in ${m.toFixed(0)}m` : `in ${(m / 60).toFixed(1)}h`;
};

function Counterfactual({ cf, vsHold }: { cf: NonNullable<TrackRecord["counterfactual"]>; vsHold?: TrackRecord["vsHold"] }) {
  const saved = -cf.pnlAfterCostsUsdt;
  const right = cf.graded ? Math.round((cf.wouldHaveLost / cf.graded) * 100) : null;
  return (
    <div className="rounded-3xl border border-line/80 bg-panel/70 p-5">
      <div className="font-display text-lg font-semibold">Were the refusals right?</div>
      <p className="mt-1 text-[13px] text-mist">Counterfactual grading: for every opportunity the committee refused, we buy at the proposal's own entry price and sell at the pool price when its own horizon ends, after both pool fees and gas both ways. Repeated refusals of the same gap count once.</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-ink-2/70 py-3">
          <div className="tnum font-display text-2xl font-semibold text-mint">{right === null ? "—" : `${right}%`}</div>
          <div className="font-mono text-[10.5px] text-dim">refusals that were right</div>
        </div>
        <div className="rounded-xl bg-ink-2/70 py-3">
          <div className={cn("tnum font-display text-2xl font-semibold", saved >= 0 ? "text-mint" : "text-coral")}>{cf.graded ? `${saved >= 0 ? "+" : "−"}$${Math.abs(saved).toFixed(4)}` : "—"}</div>
          <div className="font-mono text-[10.5px] text-dim">{saved >= 0 ? "loss avoided" : "profit missed"} ({cf.graded} graded)</div>
        </div>
        <div className="rounded-xl bg-ink-2/70 py-3">
          <div className="tnum font-display text-2xl font-semibold">{cf.pending}</div>
          <div className="font-mono text-[10.5px] text-dim">waiting for their horizon</div>
        </div>
      </div>
      <ol className="mt-3 space-y-1.5">
        {cf.items.slice(0, 5).map((i) => (
          <li key={`${i.asset}-${i.at}`} className="flex items-center justify-between gap-2 rounded-lg bg-ink-2/50 px-3 py-1.5 font-mono text-[11.5px]">
            <span className="text-mist">{i.asset} · buy {i.sizeUsdt.toFixed(2)} USDT @ {i.entry.toPrecision(5)} <span className="text-dim">({i.refusals}× refused)</span></span>
            <span className={i.pnlUsdt === null ? "text-dim" : i.pnlUsdt < 0 ? "text-mint" : "text-coral"}>
              {i.pnlUsdt === null ? `grades ${until(i.at + i.horizonSec * 1000)}` : `${i.pnlUsdt < 0 ? "would lose" : "would make"} $${Math.abs(i.pnlUsdt).toFixed(4)}`}
            </span>
          </li>
        ))}
      </ol>
      {vsHold && (
        <div className="mt-4 rounded-xl border border-line/70 px-3 py-2.5 text-[12.5px] text-mist">
          <b className="text-fog">Vault vs simply holding the deposit:</b> ${vsHold.actualUsdt.toFixed(4)} vs ${vsHold.holdUsdt.toFixed(4)} →{" "}
          <span className={vsHold.diffUsdt >= 0 ? "text-mint" : "text-coral"}>{vsHold.diffUsdt >= 0 ? "+" : "−"}${Math.abs(vsHold.diffUsdt).toFixed(4)} ({vsHold.diffPct.toFixed(2)}%)</span>. We claim no profit; this is reported either way.
        </div>
      )}
    </div>
  );
}

const PARTY_COL: Record<Party, string> = { "Execution Guardian": "#3dd6a3", "Risk Officer": "#a78bfa", "Strategy filter": "#6cb4ff", Strategist: "#f2a541" };
const PLAIN: Record<string, string> = {
  "expected-net-value": "can't pay its own fees + gas",
  "total-exposure": "would leave too little cash",
  concentration: "too much in one coin",
  "edge-or-revert": "edge below the mandate minimum",
  "price-impact": "pool too thin for the size",
  "twap-floor": "fill under the TWAP floor",
  cooldown: "too soon after the last entry",
  "daily-loss": "daily loss stop reached",
  "drawdown-breaker": "drawdown breaker",
  "market-data": "price data not trustworthy",
};
const EXPLORER = "https://hsk.blockscout.com";

function Funnel({ d }: { d: TrackRecord["decisions"] }) {
  const rows = [
    { l: "market ticks read", n: d.ticks, c: "#233a4f" },
    { l: "trades the AI proposed", n: d.proposals, c: "#6cb4ff" },
    { l: "refused by the committee", n: d.refused, c: "#ef6f5e" },
    { l: "countersigned + executed", n: d.executed, c: "#3dd6a3" },
  ];
  const max = Math.max(...rows.map((r) => r.n), 1);
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => (
        <div key={r.l}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[12.5px] text-mist">{r.l}</span>
            <span className="tnum font-display text-xl font-semibold">{r.n.toLocaleString()}</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-ink-2/70">
            <motion.div
              className="h-full rounded-full"
              style={{ background: i === 0 ? "#3a5a78" : r.c }}
              initial={{ width: "0%" }}
              whileInView={{ width: `${Math.max(2, Math.sqrt(r.n / max) * 100)}%` }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15, duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Graded from the journal (Merkle-anchored on-chain) and the trade table (each re-verifiable above). */
export function TrackRecordSection() {
  const [r, setR] = React.useState<TrackRecord | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  React.useEffect(() => {
    const load = () => endpoints.record<TrackRecord>().then(setR).catch((e) => setErr((e as Error).message));
    load();
    const t = setInterval(() => !document.hidden && load(), 30_000);
    return () => clearInterval(t);
  }, []);
  if (err && !r) return <p className="text-[13px] text-dim">Track record not available yet: {err}</p>;
  if (!r) return <div className="h-[420px] animate-pulse rounded-3xl bg-panel/60" />;

  const maxCount = Math.max(...r.refusals.map((x) => x.count), 1);
  const refusalRate = r.decisions.proposals ? Math.round((r.decisions.refused / r.decisions.proposals) * 100) : 0;
  const parties = [...new Set(r.refusals.map((x) => x.by))];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-3xl border border-line/80 bg-panel/70 p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-display text-lg font-semibold">From signal to signature</div>
            <span className="font-mono text-[11px] text-dim">updated {ago(r.at)}</span>
          </div>
          <p className="mt-1 mb-4 text-[13px] text-mist">Everything the agent did, straight from its journal. The committee refused <b className="text-fog">{refusalRate}%</b> of what the AI proposed, each time with the exact check that failed.</p>
          <Funnel d={r.decisions} />
          <div className="mt-4 rounded-xl bg-ink-2/70 px-3 py-2.5 font-mono text-[11.5px] text-mist">
            <ShieldCheck className="mr-1.5 inline size-3.5 text-mint" />
            {r.anchors.anchoredThrough.toLocaleString()} decisions committed on-chain in {r.anchors.count} Merkle root{r.anchors.count === 1 ? "" : "s"}:{" "}
            {r.anchors.roots.map((a) => (
              <a key={a.idx} href={`${EXPLORER}/tx/${a.tx}`} target="_blank" rel="noreferrer" className="mr-2 text-sky hover:underline">#{a.idx} ({a.from}–{a.to})</a>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-line/80 bg-panel/70 p-5">
          <div className="font-display text-lg font-semibold">Who said no, and why</div>
          <div className="mt-1 mb-4 flex flex-wrap gap-3 text-[12px]">
            {parties.map((p) => <span key={p} className="flex items-center gap-1.5 text-mist"><span className="size-2.5 rounded-full" style={{ background: PARTY_COL[p] }} />{p}</span>)}
          </div>
          <div className="space-y-2">
            {r.refusals.slice(0, 8).map((x, i) => {
              const key = `${x.by}|${x.check}`;
              return (
                <div key={key} onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)} className="group">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span><span className="font-mono text-fog">{x.check}</span> <span className="text-dim">· {PLAIN[x.check] ?? x.by}</span></span>
                    <span className="tnum font-mono text-mist">{x.count}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-2">
                    <motion.div className="h-full rounded-full" style={{ background: PARTY_COL[x.by] }} initial={{ width: 0 }} whileInView={{ width: `${(x.count / maxCount) * 100}%` }} viewport={{ once: true }} transition={{ delay: i * 0.06 }} />
                  </div>
                  {hover === key && <div className="mt-1 rounded-lg bg-ink px-2 py-1 font-mono text-[11px] text-dim ring-1 ring-line">{x.example}</div>}
                </div>
              );
            })}
            {r.refusals.length === 0 && <p className="text-[13px] text-dim">No refusals yet.</p>}
          </div>
          <p className="mt-4 text-[12px] text-dim">A refusal can fail several checks at once, so the bars add up to more than the refusals.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-3xl border border-line/80 bg-panel/70 p-5">
          <div className="font-display text-lg font-semibold">Executed trades</div>
          <p className="mt-1 mb-3 text-[13px] text-mist">Every trade the vault executed. Press verify to re-derive its committee signatures from the chain.</p>
          <div className="space-y-2">
            {r.trades.map((t) => {
              const sell = t.side === "SELL";
              const inAmt = Number(t.amountIn) / (sell ? 1e18 : 1e6);
              const outAmt = Number(t.amountOut) / (sell ? 1e6 : 1e18);
              return (
                <div key={t.tradeId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink-2/70 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13.5px] text-fog">
                      {sell ? `${inAmt.toLocaleString()} ${t.asset} → ${outAmt.toFixed(4)} USDT` : `${inAmt.toFixed(4)} USDT → ${outAmt.toPrecision(5)} ${t.asset}`}
                      <span className="ml-2 rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">{t.tier}</span>
                    </div>
                    <div className="font-mono text-[11px] text-dim">{new Date(t.at).toLocaleString()} · block {t.block} · {short(t.txHash)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a href={`?verify=${t.txHash}#verify`} className="rounded-lg bg-mint/15 px-2.5 py-1 font-mono text-[11.5px] text-mint hover:bg-mint/25">verify ✓</a>
                    <a href={`${EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noreferrer" aria-label="Open on explorer" className="text-sky"><ExternalLink className="size-4" /></a>
                  </div>
                </div>
              );
            })}
            {r.trades.length === 0 && <p className="text-[13px] text-dim">No executed trades yet.</p>}
          </div>
          {r.byAsset.length > 0 && (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {r.byAsset.slice(0, 3).map((a) => (
                <div key={a.asset} className="rounded-xl bg-ink-2/60 p-2.5 text-center">
                  <div className="font-display font-semibold">{a.asset}</div>
                  <div className="font-mono text-[11px] text-dim">{a.proposed} proposed · {a.refused} refused · {a.executed} done</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
        {r.counterfactual && <Counterfactual cf={r.counterfactual} vsHold={r.vsHold} />}
        <div className="rounded-3xl border border-line/80 bg-ink-2/70 p-5">
          <div className="font-display text-lg font-semibold">Latest refusals</div>
          <ol className="mt-3 space-y-2.5">
            {r.recentRefusals.slice(0, 6).map((x) => (
              <li key={x.seq} className="text-[12.5px]">
                <div className="flex items-center justify-between font-mono text-[11px] text-dim">
                  <span>#{x.seq} · {x.asset ?? "—"}</span>
                  <span>{ago(x.at)}</span>
                </div>
                <div className={cn("mt-0.5 line-clamp-2 text-mist")} title={x.summary}>{x.summary}</div>
              </li>
            ))}
          </ol>
        </div>
        </div>
      </div>
    </div>
  );
}
