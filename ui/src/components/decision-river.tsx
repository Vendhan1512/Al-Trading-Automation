import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Fingerprint, X } from "lucide-react";
import { endpoints } from "@/lib/api";
import { ago, bps, num, sig } from "@/lib/format";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import type { Decision, DecisionDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE = (o: string) =>
  ["EXECUTED", "APPROVE", "CONFIRMED", "HWM", "VALID"].includes(o) ? "#3dd6a3" : ["REJECT", "FAILED", "REVERTED", "VETO", "PAUSED", "TRIPPED"].includes(o) ? "#ef6f5e" : o === "WAIT" ? "#f2a541" : "#74879a";

type Group = { first: Decision; items: Decision[] };
function group(list: Decision[]): Group[] {
  const out: Group[] = [];
  for (const d of list) {
    const last = out[out.length - 1];
    if (last && last.first.outcome === d.outcome && d.outcome === "WAIT" && last.first.kind === d.kind) last.items.push(d);
    else out.push({ first: d, items: [d] });
  }
  return out;
}

function Heartbeat({ list, onPick, picked }: { list: Decision[]; onPick: (s: number) => void; picked: number | null }) {
  const [hover, setHover] = React.useState<Decision | null>(null);
  const ordered = [...list].reverse();
  return (
    <div className="relative">
      <div className="flex h-12 items-end gap-px" onPointerLeave={() => setHover(null)}>
        {ordered.map((d, i) => (
          <motion.button
            key={d.seq}
            aria-label={`Decision ${d.seq}: ${d.outcome}`}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ delay: Math.min(1, i * 0.006) }}
            onPointerEnter={() => setHover(d)}
            onFocus={() => setHover(d)}
            onClick={() => onPick(d.seq)}
            className={cn("min-w-0 flex-1 origin-bottom rounded-t-[2px] transition-[height,opacity] hover:opacity-100", picked === d.seq ? "opacity-100" : "opacity-70")}
            style={{ background: TONE(d.outcome), height: d.outcome === "WAIT" ? "45%" : "100%" }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-dim">
        <span>{ordered[0] ? ago(ordered[0].at) : ""}</span>
        <span>now</span>
      </div>
      <AnimatePresence>
        {hover && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="pointer-events-none absolute -top-14 left-0 right-0 truncate rounded-lg bg-ink px-3 py-2 font-mono text-[11.5px] text-mist ring-1 ring-line">
            #{hover.seq} · {hover.outcome} · {hover.summary}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Detail({ seq }: { seq: number }) {
  const [d, setD] = React.useState<DecisionDetail | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    setD(null); setErr(null);
    endpoints.decision(seq).then(setD).catch((e) => setErr((e as Error).message));
  }, [seq]);
  if (err) return <div className="text-[13px] text-dim">This decision isn't in the public snapshot (only the most recent are published).</div>;
  if (!d) return <div className="h-40 animate-pulse rounded-xl bg-ink-2/60" />;
  const p = d.payload ?? {};
  const g = p.guardian;
  const e = g?.economics ?? {};
  return (
    <motion.div key={seq} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} className="space-y-4 text-[13.5px]">
      <div className="flex items-start gap-2 rounded-xl bg-ink-2/70 p-3">
        <Fingerprint className="mt-0.5 size-4 shrink-0 text-mint" />
        <div className="min-w-0">
          <div className="font-mono text-[11px] break-all text-mist">{d.hash}</div>
          <div className="mt-1 text-[12px] text-dim">
            Hashed into the journal and anchored on-chain. Check it yourself: <code className="font-mono text-mist">pnpm verify decision {seq}</code>
          </div>
        </div>
      </div>
      {p.candidate && (
        <section>
          <h4 className="eyebrow mb-1.5">Candidate</h4>
          <div className="text-fog">{p.candidate.side} {p.candidate.asset} up to {num(p.candidate.maxSizeUsdt, 2)} USDT · tier {p.candidate.tier}</div>
          <div className="text-mist">{p.candidate.thesis} · gross edge {bps(p.candidate.grossEdgeBps)}</div>
        </section>
      )}
      {p.strategist && (
        <section>
          <h4 className="eyebrow mb-1.5">Strategist · {p.strategist.source}</h4>
          <div className="text-mist">{p.strategist.action} · p = {num(p.strategist.probability, 2)} · {p.strategist.rationale}</div>
        </section>
      )}
      {g && (
        <section>
          <h4 className="eyebrow mb-1.5 flex items-center gap-2">Guardian <StatusBadge status={g.decision} /></h4>
          <ul className="grid gap-1">
            {(g.checks ?? []).map((c, i) => (
              <motion.li key={c.name} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.035 }} className="flex items-center gap-2">
                {c.pass ? <Check className="size-3.5 text-mint" /> : <X className="size-3.5 text-coral" />}
                <span className={c.pass ? "text-mist" : "text-coral"}>{c.name}</span>
                {c.value !== undefined && c.value !== null && <span className="font-mono text-[11px] text-dim">{String(c.value)}{c.limit !== undefined && c.limit !== null ? ` / ${String(c.limit)}` : ""}</span>}
              </motion.li>
            ))}
          </ul>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[12px]">
            <span className="text-dim">expected net</span><span className={(e.expectedNetValueUsdt ?? 0) > 0 ? "text-mint" : "text-coral"}>{num(e.expectedNetValueUsdt, 4)} USDT</span>
            <span className="text-dim">edge · impact</span><span className="text-mist">{bps(e.edgeBps)} · {num(e.impactBps, 1)} bps</span>
            <span className="text-dim">pool / reference</span><span className="text-mist">{sig(e.dexSpot)} / {sig(e.referencePrice)}</span>
          </div>
        </section>
      )}
      {!p.candidate && p.health && (
        <section>
          <h4 className="eyebrow mb-1.5">Market at this tick</h4>
          <div className="grid gap-1">
            {p.health.map((a) => (
              <div key={a.asset} className="flex items-center gap-2"><span className="w-12 font-mono text-[12px] text-fog">{a.asset}</span><StatusBadge status={a.status} /><span className="font-mono text-[12px] text-mist">{bps(a.premiumBps)}</span></div>
            ))}
          </div>
          {p.cycles && <div className="mt-2 text-[12px] text-dim">Tier A: {p.cycles.note}</div>}
        </section>
      )}
    </motion.div>
  );
}

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "trades", label: "Trades", test: (d: Decision) => !["tick", "keeper", "breaker"].includes(d.kind ?? "") },
  { id: "keeper", label: "Keeper", test: (d: Decision) => d.kind === "keeper" || d.kind === "breaker" },
  { id: "waits", label: "Waits", test: (d: Decision) => d.outcome === "WAIT" },
] as const;

export function DecisionRiver({ decisions }: { decisions: Decision[] }) {
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["id"]>("all");
  const [picked, setPicked] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState<number | null>(null);
  const f = FILTERS.find((x) => x.id === filter)!;
  const list = decisions.filter(f.test);
  const groups = group(list).slice(0, 40);
  React.useEffect(() => { if (picked === null && decisions[0]) setPicked(decisions[0].seq); }, [decisions, picked]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Card className="min-w-0">
        <CardHeader title="Heartbeat" meta={`${decisions.length} latest decisions · one bar each · click to inspect`} />
        <Heartbeat list={decisions} onPick={setPicked} picked={picked} />
        <div className="mt-6 mb-3 flex flex-wrap gap-1.5">
          {FILTERS.map((x) => (
            <button key={x.id} onClick={() => setFilter(x.id)} className={cn("relative rounded-full px-3 py-1 text-[12.5px] transition-colors", filter === x.id ? "text-ink" : "text-mist hover:text-fog")}>
              {filter === x.id && <motion.span layoutId="dr-filter" className="absolute inset-0 rounded-full bg-mint" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
              <span className="relative">{x.label} <span className="opacity-60">{decisions.filter(x.test).length}</span></span>
            </button>
          ))}
        </div>
        <ul className="max-h-[460px] space-y-1.5 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {groups.map((gr) => {
              const d = gr.first;
              const many = gr.items.length > 1;
              const isOpen = open === d.seq;
              return (
                <motion.li key={d.seq} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <button
                    onClick={() => { setPicked(d.seq); if (many) setOpen(isOpen ? null : d.seq); }}
                    className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors", picked === d.seq ? "bg-panel-2 ring-1 ring-mint/30" : "hover:bg-ink-2/70")}
                  >
                    <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: TONE(d.outcome) }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11.5px] text-dim">#{d.seq}</span>
                        <StatusBadge status={d.outcome} />
                        {many && <span className="rounded-full bg-amber/10 px-2 py-0.5 font-mono text-[10.5px] text-amber">×{gr.items.length} in a row</span>}
                        <span className="font-mono text-[11px] text-dim">{ago(d.at)}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 block text-[13px] text-mist">{d.summary}</span>
                    </span>
                    {many && <ChevronRight className={cn("mt-1 size-4 shrink-0 text-dim transition-transform", isOpen && "rotate-90")} />}
                  </button>
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pl-8">
                        <div className="flex flex-wrap gap-1 py-2">
                          {gr.items.map((x) => (
                            <button key={x.seq} onClick={() => setPicked(x.seq)} className={cn("rounded-md px-1.5 py-0.5 font-mono text-[10.5px]", picked === x.seq ? "bg-mint text-ink" : "bg-ink-2 text-dim hover:text-fog")}>#{x.seq}</button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </AnimatePresence>
          {!groups.length && <li className="py-8 text-center text-[13px] text-dim">Nothing here yet.</li>}
        </ul>
      </Card>
      <Card className="lg:sticky lg:top-24 lg:self-start">
        <CardHeader title={picked !== null ? `Decision #${picked}` : "Decision"} meta="every check, every number" />
        {picked !== null ? <Detail seq={picked} /> : <div className="text-[13px] text-dim">Pick a decision.</div>}
      </Card>
    </div>
  );
}
