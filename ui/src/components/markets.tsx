import * as React from "react";
import { motion } from "motion/react";
import { endpoints } from "@/lib/api";
import { ago, bps, num, sig } from "@/lib/format";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import type { Arbitrage, AssetPrice, Prices } from "@/lib/types";
import { cn } from "@/lib/utils";

const ASSET_COL: Record<string, string> = { WHSK: "#f2a541", WETH: "#7892ec", WBTC: "#e0783a" };

function Spark({ asset }: { asset: string }) {
  const [pts, setPts] = React.useState<{ t: number; v: number }[]>([]);
  const [hover, setHover] = React.useState<number | null>(null);
  React.useEffect(() => {
    endpoints.history(asset).then((h) => setPts(h.points.filter((p) => p.ref && p.dex).map((p) => ({ t: p.t, v: ((p.dex! - p.ref!) / p.ref!) * 1e4 })))).catch(() => setPts([]));
  }, [asset]);
  if (pts.length < 2) return <div className="grid h-[72px] place-items-center font-mono text-[11px] text-dim">collecting history…</div>;
  const W = 300, H = 72, Pd = 4;
  const ys = pts.map((p) => p.v);
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), span = hi - lo || 1;
  const x = (i: number) => Pd + (i * (W - 2 * Pd)) / (pts.length - 1);
  const y = (v: number) => H - Pd - ((v - lo) * (H - 2 * Pd)) / span;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${d}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const col = ASSET_COL[asset] ?? "#6cb4ff";
  const h = hover !== null ? pts[hover] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[72px] w-full cursor-crosshair"
        role="img"
        aria-label={`${asset} price gap history, latest ${bps(ys.at(-1))}`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`sp-${asset}`} x1={0} x2={0} y1={0} y2={1}>
            <stop offset={0} stopColor={col} stopOpacity={0.28} />
            <stop offset={1} stopColor={col} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line x1={Pd} x2={W - Pd} y1={y(0)} y2={y(0)} stroke="#233a4f" strokeDasharray="3 4" />
        <path d={area} fill={`url(#sp-${asset})`} />
        <motion.path d={d} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: "easeOut" }} />
        {hover !== null && h && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="#a9b8c4" strokeOpacity={0.4} />
            <circle cx={x(hover)} cy={y(h.v)} r={4} fill={col} stroke="#0b1219" strokeWidth={2} />
          </>
        )}
      </svg>
      {h && (
        <div className="pointer-events-none absolute -top-8 right-0 rounded-md bg-ink px-2 py-1 font-mono text-[11px] text-fog ring-1 ring-line">
          {new Date(h.t).toLocaleTimeString()} · {bps(h.v)}
        </div>
      )}
    </div>
  );
}

function AssetCard({ a, i }: { a: AssetPrice; i: number }) {
  const cheap = a.premiumBps < 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: i * 0.08 }}
      className="rounded-2xl border border-line/80 bg-ink-2/70 p-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: ASSET_COL[a.asset] }} />
          <span className="font-display text-[17px] font-semibold">{a.asset}</span>
        </div>
        <StatusBadge status={a.status} />
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] text-dim">HSKSwap pool</div>
          <div className="tnum font-display text-[22px] font-semibold">{sig(a.dexSpot, 5)}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[11px] text-dim">vs exchanges</div>
          <div className={cn("tnum font-display text-[22px] font-semibold", cheap ? "text-mint" : "text-amber")}>{bps(a.premiumBps)}</div>
        </div>
      </div>
      <div className="mt-3"><Spark asset={a.asset} /></div>
      <div className="mt-2 font-mono text-[10.5px] text-dim" title={a.sources.map((s) => `${s.source} ${s.mid}${s.accepted ? "" : " (rejected)"}`).join("\n")}>
        reference = median of {a.sources.filter((s) => s.accepted).map((s) => s.source).join(", ")}
      </div>
    </motion.div>
  );
}

export function Markets({ prices, arbitrage }: { prices: Prices | null; arbitrage: Arbitrage | null }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {prices ? prices.assets.map((a, i) => <AssetCard key={a.asset} a={a} i={i} />) : Array.from({ length: 3 }, (_, i) => <div key={i} className="h-[220px] animate-pulse rounded-2xl bg-panel/60" />)}
      </div>
      {arbitrage && (
        <Card>
          <CardHeader title="Arbitrage radar" meta={`every HSK venue at executable size · gas ≈ ${num(arbitrage.gasPerSwapUsdt, 4)} USDT per swap · ${ago(arbitrage.at)}`} />
          <div className="grid gap-2">
            {arbitrage.routes.map((r) => {
              const net = r.best?.netUsdt ?? null;
              const gross = r.best?.grossProfitUsdt ?? null;
              const pays = net !== null && net > 0;
              const w = Math.min(100, Math.abs(r.midGapBps) / 2);
              return (
                <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-ink-2/60 px-3 py-2.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]">
                  <div className="min-w-0 truncate text-[13.5px]">{r.name}</div>
                  <div className="hidden items-center gap-2 sm:flex">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line/60">
                      <motion.div className="h-full rounded-full bg-sky" initial={{ width: 0 }} whileInView={{ width: `${w}%` }} viewport={{ once: true }} />
                    </div>
                    <span className="tnum w-16 text-right font-mono text-[11.5px] text-mist">{bps(r.midGapBps)}</span>
                  </div>
                  <div className="tnum hidden text-right font-mono text-[11.5px] text-dim sm:block">before gas {num(gross, 4)}</div>
                  <div className="flex items-center gap-2">
                    <span className={cn("tnum font-mono text-[12px]", pays ? "text-mint" : "text-coral")}>{num(net, 4)}</span>
                    <StatusBadge status={pays ? "VALID" : "WAIT"} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[12.5px] text-dim">{arbitrage.summary} Depth: {arbitrage.venues.map((v) => `${v.name} $${Math.round(v.depthUsdt).toLocaleString()}`).join(" · ")}.</p>
        </Card>
      )}
    </div>
  );
}
