import * as React from "react";
import { motion, useScroll, useSpring } from "motion/react";
import { Code2 } from "lucide-react";
import { useData } from "@/hooks/use-data";
import { Hero } from "@/components/hero";
import { CountersignStage } from "@/components/countersign-stage";
import { BreakItArena } from "@/components/break-it-arena";
import { Markets } from "@/components/markets";
import { DecisionRiver } from "@/components/decision-river";
import { MissionControl } from "@/components/mission-control";
import { Evidence } from "@/components/evidence";
import { Pill } from "@/components/ui/badge";
import { ago, bps } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { id: "how", label: "How it works" },
  { id: "break", label: "Break it" },
  { id: "markets", label: "Markets" },
  { id: "decisions", label: "Decisions" },
  { id: "mission", label: "Mission Control" },
  { id: "evidence", label: "Evidence" },
];

function useScrollSpy(ids: string[]) {
  const [active, setActive] = React.useState<string | null>(null);
  React.useEffect(() => {
    const io = new IntersectionObserver(
      (es) => { for (const e of es) if (e.isIntersecting) setActive(e.target.id); },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#132230" stroke="#233a4f" />
      <circle cx="13" cy="16" r="7" fill="none" stroke="#3dd6a3" strokeWidth="2.4" />
      <circle cx="19" cy="16" r="7" fill="none" stroke="#6cb4ff" strokeWidth="2.4" />
    </svg>
  );
}

function Section({ id, eyebrow, title, lede, children }: { id: string; eyebrow: string; title: string; lede: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
      <motion.div initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} className="mb-8 max-w-3xl">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-3 font-display text-[32px] leading-tight font-bold tracking-[-0.03em] sm:text-[42px]">{title}</h2>
        <p className="mt-3 text-[16px] leading-relaxed text-mist">{lede}</p>
      </motion.div>
      {children}
    </section>
  );
}

export default function App() {
  const d = useData();
  const active = useScrollSpy(React.useMemo(() => NAV.map((n) => n.id), []));
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 200, damping: 40 });
  const live = d.config?.mode === "live";
  const latestSeq = d.decisions[0]?.seq ?? 0;

  const ticker = [
    ...(d.prices?.assets.map((a) => `${a.asset} ${a.dexSpot.toPrecision(5)} · ${bps(a.premiumBps)} vs exchanges`) ?? []),
    d.decisions[0] ? `latest decision #${d.decisions[0].seq} · ${d.decisions[0].outcome} · ${ago(d.decisions[0].at)}` : "",
    "committee 2-of-2 · Guardian + Risk Officer",
    "stop-loss armed · anyone can fire it",
  ].filter(Boolean);

  return (
    <div className="min-h-screen">
      <motion.div className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-gradient-to-r from-mint to-sky" style={{ scaleX: progress }} />
      <header className="sticky top-0 z-40 border-b border-line/60 bg-ink/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-5 sm:px-8">
          <a href="#" className="flex items-center gap-2.5">
            <Logo />
            <span className="font-display text-[17px] font-bold tracking-tight">Countersign</span>
          </a>
          <nav className="ml-4 hidden items-center gap-0.5 lg:flex">
            {NAV.map((n) => (
              <a key={n.id} href={`#${n.id}`} className={cn("relative rounded-full px-3 py-1.5 text-[13.5px] transition-colors", active === n.id ? "text-ink" : "text-mist hover:text-fog")}>
                {active === n.id && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-mint" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <span className="relative">{n.label}</span>
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Pill tone={live ? "good" : "warn"} className="hidden sm:inline-flex">
              <span className="relative flex size-2">
                <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", live ? "bg-mint" : "bg-amber")} />
                <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-mint" : "bg-amber")} />
              </span>
              {d.staticMode ? `snapshot · ${live ? "live agent" : "shadow agent"}` : live ? "live trading" : "shadow mode"}
            </Pill>
            <Pill tone="info">HSK {d.config?.chainId ?? 177}</Pill>
            <a href="https://github.com/Vendhan1512/Al-Trading-Automation" target="_blank" rel="noreferrer" aria-label="Source on GitHub" className="grid size-9 place-items-center rounded-xl border border-line text-mist hover:text-fog">
              <Code2 className="size-4" />
            </a>
          </div>
        </div>
        <div className="overflow-hidden border-t border-line/40 bg-ink-2/60">
          <div className="flex w-max animate-marquee gap-10 py-1.5 font-mono text-[11.5px] text-dim">
            {[...ticker, ...ticker].map((t, i) => <span key={i} className="whitespace-nowrap"><span className="mr-2 text-mint">◆</span>{t}</span>)}
          </div>
        </div>
      </header>

      <main>
        <Hero portfolio={d.portfolio} decisions={latestSeq} />

        <Section id="how" eyebrow="The two-person rule, on-chain" title="Every trade needs two signatures it can’t forge." lede="Pick a scenario. The trade travels as a permit: the Execution Guardian prices it and seals it, the Risk Officer re-checks it with its own data, and the vault only executes with both seals inside your rules.">
          <CountersignStage config={d.config} />
        </Section>

        <Section id="break" eyebrow="Don’t trust us. Attack it." title="15 real attacks against the live vault." lede="Each one plays a stolen key, a rogue committee member or a stranger. They run as real calls against the contract on HashKey Chain, straight from your browser, and the vault answers with its own refusal.">
          <BreakItArena config={d.config} />
        </Section>

        <Section id="markets" eyebrow="What the agent sees" title="Prices it trusts, gaps it refuses." lede="The pool price is compared with exchanges that pass freshness, spread and outlier checks. The radar prices every HSK venue at a size you could actually trade, after gas, and says so when nothing pays.">
          <Markets prices={d.prices} arbitrage={d.arbitrage} />
        </Section>

        <Section id="decisions" eyebrow="Every decision, provable" title="A heartbeat you can audit." lede="The agent journals every tick, including every refusal. Each record is hashed and anchored on-chain in a Merkle root, so anyone can check a decision wasn’t rewritten later.">
          <DecisionRiver decisions={d.decisions} />
        </Section>

        <Section id="mission" eyebrow="Mission Control" title="Tell it how to trade, in plain words." lede="Ask about P&L, ask what-if, or set size, frequency, assets and stop-loss. It proposes a diff; stricter rules apply at once, looser ones need your wallet.">
          <MissionControl config={d.config} staticMode={d.staticMode} />
        </Section>

        <Section id="evidence" eyebrow="Evidence" title="Don’t take our word for it." lede="Verified contracts, real transactions and a verifier that re-derives any trade from the chain.">
          <Evidence config={d.config} health={d.health} />
        </Section>
      </main>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-8 text-[12.5px] text-dim sm:px-8">
          <span>Countersign · HSK Chain Horizon Hackathon · Track 1 · unaudited prototype, tiny sizes</span>
          <span>{d.staticMode && d.config?.publishedAt ? `snapshot published ${ago(d.config.publishedAt)} · ` : ""}Vault Pour interaction inspired by Aakash Mehra’s Coffee Pour Menu</span>
        </div>
      </footer>
    </div>
  );
}
