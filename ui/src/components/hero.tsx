import * as React from "react";
import { motion } from "motion/react";
import { ArrowDown, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VaultPour, type Liquid, type PourScene } from "@/components/vault-pour";
import { usd } from "@/lib/format";
import type { Portfolio } from "@/lib/types";

const ASSET_LIQ: Record<string, Liquid> = { WHSK: "whsk", WETH: "weth", WBTC: "wbtc" };

function liveScene(pf: Portfolio | null): PourScene {
  const parts: { type: Liquid; v: number }[] = [];
  if (pf) {
    if (pf.usdt > 0) parts.push({ type: "usdt", v: pf.usdt });
    for (const p of pf.positions) if (ASSET_LIQ[p.asset] && p.exitValueUsdt > 0) parts.push({ type: ASSET_LIQ[p.asset], v: p.exitValueUsdt });
  }
  const total = parts.reduce((a, b) => a + b.v, 0);
  const layers = total > 0 ? parts.map((x) => ({ type: x.type, amount: Math.max(0.05, (x.v / total) * 0.62) })) : [{ type: "whsk" as Liquid, amount: 0.3 }];
  const pos = pf?.positions[0];
  return {
    id: "live",
    name: "Your vault, live",
    subtitle: pf ? `${usd(pf.totalValueUsdt, 2)} · ${pf.positions.map((p) => `${p.qty} ${p.asset}`).join(" + ") || "empty"}${pf.usdt ? ` + ${pf.usdt.toFixed(2)} USDT` : ""}` : "reading the chain…",
    caption: pf ? `Real holdings of vault ${pf.vault?.slice(0, 6)}…, valued at the pool's 30-minute average. ${pf.mandate.stopLossBps ? `The stop-loss is armed at ${(pf.mandate.stopLossBps / 100).toFixed(0)}% below cost.` : ""}` : "Loading the vault from HashKey Chain…",
    layers,
    pricePct: pos ? pos.unrealizedPct : 0,
  };
}

const SCENES: PourScene[] = [
  { id: "deposit", name: "Deposit 5 USDT", subtitle: "buying power for the agent", caption: "USDT lets the agent buy when the pool is cheap. It only trades when the edge pays for gas both ways.", layers: [{ type: "whsk", amount: 0.08 }, { type: "usdt", amount: 0.55 }], pricePct: 0.4 },
  { id: "trade", name: "Countersigned trade", subtitle: "Guardian ✓ · Risk Officer ✓", caption: "Both committee keys sign the exact route, size and floor. Only then does the vault swap USDT into WHSK.", layers: [{ type: "usdt", amount: 0.34 }, { type: "whsk", amount: 0.3 }], pricePct: 0.8, effect: "seal" },
  { id: "stop", name: "Stop-loss fires", subtitle: "permissionless · no bot needed", caption: "The 30-minute average falls 3% below cost. Anyone can call stopOut(); the vault exits to USDT at a TWAP-anchored floor.", layers: [{ type: "usdt", amount: 0.12 }, { type: "whsk", amount: 0.5 }], pricePct: -3.6, effect: "stop" },
  { id: "breaker", name: "Drawdown breaker", subtitle: "−10% NAV · entries locked", caption: "The vault's value drops 10% from its high. New entries lock; exits and stops stay open. Only the owner can reset it.", layers: [{ type: "usdt", amount: 0.28 }, { type: "whsk", amount: 0.3 }], pricePct: -2.2, effect: "breaker" },
];

export function Hero({ portfolio, decisions }: { portfolio: Portfolio | null; decisions: number }) {
  const live = React.useMemo(() => liveScene(portfolio), [portfolio]);
  const scenes = React.useMemo(() => [live, ...SCENES], [live]);
  const word = { hidden: { opacity: 0, y: 24, filter: "blur(6px)" }, show: { opacity: 1, y: 0, filter: "blur(0px)" } };
  return (
    <section className="relative mx-auto max-w-7xl px-5 pt-10 pb-16 sm:px-8 sm:pt-16">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="eyebrow">HashKey Chain · HSKSwap · Track 1</motion.p>
          <motion.h1 initial="hidden" animate="show" transition={{ staggerChildren: 0.07 }} className="mt-4 font-display text-[44px] leading-[1.02] font-bold tracking-[-0.035em] sm:text-[60px] xl:text-[64px]">
            {["The AI", "trader that"].map((w) => <motion.span key={w} variants={word} className="mr-[0.25em] inline-block whitespace-nowrap">{w}</motion.span>)}
            <br />
            <motion.span variants={word} className="inline-block bg-gradient-to-r from-mint to-sky bg-clip-text text-transparent">can’t trade alone.</motion.span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }} className="mt-5 max-w-xl text-[17px] leading-relaxed text-mist">
            Claude proposes every trade. A two-person committee must countersign it, and the vault on HashKey Chain checks both signatures before a single token moves. A stolen key, a tricked model or a dead bot isn’t enough.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }} className="mt-7 flex flex-wrap gap-3">
            <a href="#break"><Button size="lg"><Swords className="size-4" /> Try to break it</Button></a>
            <a href="#how"><Button size="lg" variant="ghost">Watch a trade <ArrowDown className="size-4" /></Button></a>
          </motion.div>
          <motion.dl initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="mt-10 grid max-w-xl grid-cols-2 gap-4 border-t border-line/70 pt-6 sm:grid-cols-4">
            {[["2-of-2", "committee on every trade"], ["15/15", "attacks blocked on mainnet"], ["−91%", "losses vs rules alone (30-day backtest)"], [String(decisions || "—"), "decisions journaled"]].map(([n, l]) => (
              <div key={l}>
                <dt className="sr-only">{l}</dt>
                <dd className="font-display text-[26px] font-bold tracking-tight text-fog">{n}</dd>
                <dd className="text-[12.5px] leading-snug text-dim">{l}</dd>
              </div>
            ))}
          </motion.dl>
        </div>
        <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, type: "spring", stiffness: 120, damping: 20 }}>
          <VaultPour scenes={scenes} />
        </motion.div>
      </div>
    </section>
  );
}
