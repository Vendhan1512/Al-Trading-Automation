import * as React from "react";
import { animate, motion, useInView } from "motion/react";
import { ExternalLink } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { num, short } from "@/lib/format";
import type { Config, Health } from "@/lib/types";

export function CountUp({ to, decimals = 0, suffix = "" }: { to: number; decimals?: number; suffix?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  React.useEffect(() => {
    if (!inView || !ref.current) return;
    const c = animate(0, to, { duration: 1.2, ease: "easeOut", onUpdate: (v) => { if (ref.current) ref.current.textContent = `${v.toFixed(decimals)}${suffix}`; } });
    return () => c.stop();
  }, [inView, to, decimals, suffix]);
  return <span ref={ref} className="tnum">{`${(0).toFixed(decimals)}${suffix}`}</span>;
}

const PROOFS: { label: string; detail: string; hash: string; net: "mainnet" | "testnet" }[] = [
  { label: "Owner creates the 2-of-2 vault", detail: "createVault from the owner's wallet", hash: "0x50e4f0c427e15efe34ffab430705d186f50b5301354dfebecec97b846d560100", net: "mainnet" },
  { label: "Decision anchor #0", detail: "475 decisions in one Merkle root · verify decision → 3/3", hash: "0x9ad3ce936fadc559d92351ff835e35f74e8696b835ba1b72ead827771f21dea7", net: "mainnet" },
  { label: "Keeper records the high-water mark", detail: "checkBreaker, sent by the agent", hash: "0x896f69019e99cb4f0fa13a7fe7b846f0ad52adcf1d16a172f13b1902ba43879e", net: "mainnet" },
  { label: "Committee-signed trade executes", detail: "2-of-2 permit · pnpm verify trade → 14/14", hash: "0x4cbbc0e4a64e95505e3fd92ba43a6f25ed84e04df47d432d95852bd5ea65c24f", net: "testnet" },
];
const EXP = { mainnet: "https://hsk.blockscout.com", testnet: "https://testnet-explorer.hskchain.net" };

export function Evidence({ config, health }: { config?: Config | null; health?: Health | null }) {
  const c = config?.contracts;
  const contracts = [
    ["Your vault (2-of-2)", config?.vault],
    ["CountersignVault v2 implementation", c?.vaultImplementation],
    ["VaultFactory v2", c?.vaultFactory],
    ["HSKSwap SwapRouter02", c?.router],
  ] as const;
  const stats = [
    { n: 214, l: "tests passing", s: "101 contract · 113 agent" },
    { n: 15, l: "attacks blocked", s: "live, on mainnet" },
    { n: 475, l: "decisions anchored", s: "one Merkle root" },
    { n: -91, l: "% losses vs rules alone", s: "30-day backtest", suffix: "%" },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s, i) => (
          <motion.div key={s.l} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.07 }} className="rounded-2xl border border-line/80 bg-panel/60 p-4">
            <div className="font-display text-[34px] leading-none font-bold text-mint"><CountUp to={s.n} suffix={s.suffix ?? ""} /></div>
            <div className="mt-2 text-[13.5px] text-fog">{s.l.replace("% ", "")}</div>
            <div className="font-mono text-[11px] text-dim">{s.s}</div>
          </motion.div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="On-chain proof" meta="click to open on the explorer" />
          <ol className="relative space-y-4 border-l border-line pl-5">
            {PROOFS.map((p, i) => (
              <motion.li key={p.hash} initial={{ opacity: 0, x: -10 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }} className="relative">
                <span className="absolute top-1.5 -left-[26px] size-2.5 rounded-full bg-mint ring-4 ring-ink" />
                <a href={`${EXP[p.net]}/tx/${p.hash}`} target="_blank" rel="noreferrer" className="group block">
                  <div className="flex items-center gap-2 font-medium text-fog group-hover:text-mint">
                    {p.label} <ExternalLink className="size-3.5 opacity-50" />
                    <span className="rounded-full bg-ink-2 px-2 py-0.5 font-mono text-[10px] text-dim">{p.net}</span>
                  </div>
                  <div className="text-[13px] text-mist">{p.detail}</div>
                  <div className="font-mono text-[11px] text-dim">{short(p.hash)}</div>
                </a>
              </motion.li>
            ))}
          </ol>
        </Card>
        <Card>
          <CardHeader title="Contracts" meta="verified · Sourcify exact match + Blockscout" />
          <ul className="space-y-2">
            {contracts.map(([l, a]) => (
              <li key={l} className="flex items-center justify-between gap-3 rounded-xl bg-ink-2/60 px-3 py-2.5">
                <span className="text-[13.5px] text-mist">{l}</span>
                {a ? <a className="font-mono text-[12px] text-sky hover:underline" href={`${config?.explorer}/address/${a}`} target="_blank" rel="noreferrer">{short(a)}</a> : <span className="text-dim">—</span>}
              </li>
            ))}
          </ul>
          {health && (
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              {[["fills", String(health.trades)], ["net P&L", `${num(health.netPnlUsdt, 3)}`], ["gas paid", `${num(health.gasUsdt, 3)}`]].map(([l, v]) => (
                <div key={l} className="rounded-xl bg-ink-2/60 py-2.5">
                  <div className="tnum font-display text-lg font-semibold">{v}</div>
                  <div className="font-mono text-[10.5px] text-dim">{l}</div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-[12.5px] text-dim">Unaudited hackathon code with deliberately tiny sizes. We claim the AI can't act alone, not that it's profitable.</p>
        </Card>
      </div>
    </div>
  );
}
