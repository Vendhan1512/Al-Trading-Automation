import * as React from "react";
import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react";
import { Bot, Landmark, Play, ScanSearch, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { short } from "@/lib/format";
import type { Config } from "@/lib/types";

type StationId = "agent" | "guardian" | "risk" | "vault";
type Step = { at: StationId; text: string; tone?: "ok" | "bad" | "info"; seal?: "g" | "r"; stamp?: string };
interface Scenario { id: string; name: string; sub: string; steps: Step[]; ending: "execute" | "bounce" | "drop" }

const SCENARIOS: Scenario[] = [
  {
    id: "good", name: "A good trade", sub: "2 of 2 sign · executes", ending: "execute",
    steps: [
      { at: "agent", text: "Claude proposes: BUY 5 USDT of WHSK. The pool is 70 bps under the exchanges.", tone: "info" },
      { at: "guardian", text: "Guardian re-prices it: impact 4 bps, gas both ways included, expected net +0.012 USDT. Signs.", tone: "ok", seal: "g" },
      { at: "risk", text: "Risk Officer re-checks with its own data and a stricter impact limit. Co-signs.", tone: "ok", seal: "r" },
      { at: "vault", text: "Vault verifies both EIP-712 signatures, the mandate and the TWAP floor. execute() ✓", tone: "ok", stamp: "EXECUTED" },
    ],
  },
  {
    id: "stolen", name: "Stolen agent key", sub: "no countersignature", ending: "bounce",
    steps: [
      { at: "agent", text: "An attacker holds the agent key and builds a trade that drains into a bad pool.", tone: "bad" },
      { at: "vault", text: "Sent straight to the vault with no committee signatures. Reverts: NotEnoughSignatures(0, 2).", tone: "bad", stamp: "NotEnoughSignatures(0, 2)" },
    ],
  },
  {
    id: "gas", name: "Doesn't pay its gas", sub: "Guardian refuses", ending: "drop",
    steps: [
      { at: "agent", text: "Claude likes a 1 USDT spread trade on WETH.", tone: "info" },
      { at: "guardian", text: "Two pool fees plus gas both ways cost more than the edge: expected net −0.004 USDT. Refused.", tone: "bad", stamp: "REFUSED · net < 0" },
    ],
  },
  {
    id: "veto", name: "Risk Officer veto", sub: "1 of 2 isn't enough", ending: "drop",
    steps: [
      { at: "agent", text: "Claude proposes 5 USDT of WBTC.", tone: "info" },
      { at: "guardian", text: "Guardian: impact 41 bps is inside its 50 bps limit. Signs.", tone: "ok", seal: "g" },
      { at: "risk", text: "Risk Officer: 41 bps breaks its stricter 30 bps limit. Vetoes. One signature can't execute.", tone: "bad", stamp: "VETO" },
    ],
  },
  {
    id: "loosen", name: "AI loosens its limits", sub: "tighten() only tightens", ending: "bounce",
    steps: [
      { at: "agent", text: "A prompt-injected model asks the vault to raise its trade cap 10×.", tone: "bad" },
      { at: "vault", text: "tighten() can only make rules stricter. Reverts: NotTighter. Only the owner's wallet can loosen.", tone: "bad", stamp: "NotTighter" },
    ],
  },
];

const STATIONS: { id: StationId; label: string; role: string; Icon: typeof Bot; key: (c?: Config | null) => string | null | undefined }[] = [
  { id: "agent", label: "Agent", role: "Claude proposes", Icon: Bot, key: (c) => c?.agent },
  { id: "guardian", label: "Execution Guardian", role: "prices & signs", Icon: ScanSearch, key: (c) => c?.guardian },
  { id: "risk", label: "Risk Officer", role: "re-checks & co-signs", Icon: ShieldCheck, key: (c) => c?.riskOfficer },
  { id: "vault", label: "Vault", role: "enforces 2-of-2", Icon: Landmark, key: (c) => c?.vault },
];

function Envelope({ seals }: { seals: { g: boolean; r: boolean } }) {
  return (
    <svg viewBox="0 0 120 80" className="h-full w-full drop-shadow-[0_10px_14px_rgba(0,0,0,0.45)]">
      <rect x={2} y={4} width={116} height={72} rx={6} fill="#f6ecdd" stroke="#c9b28f" strokeWidth={1.5} />
      <path d="M4 8 L60 46 L116 8" fill="none" stroke="#c9b28f" strokeWidth={1.5} />
      <path d="M4 74 L46 38 M116 74 L74 38" fill="none" stroke="#e0cfb4" strokeWidth={1.2} />
      <text x={60} y={68} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={8.5} fontWeight={700} fill="#8a6c4f" letterSpacing={1.4}>PERMIT</text>
      <AnimatePresence>
        {seals.g && (
          <motion.g key="g" initial={{ scale: 2.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 520, damping: 18 }} style={{ originX: "38px", originY: "44px" }}>
            <circle cx={38} cy={44} r={13} fill="#c2412f" />
            <circle cx={38} cy={44} r={9.5} fill="none" stroke="#e98a77" strokeWidth={1.3} />
            <text x={38} y={48} textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontSize={11} fontWeight={700} fill="#fde8de">G</text>
          </motion.g>
        )}
        {seals.r && (
          <motion.g key="r" initial={{ scale: 2.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 520, damping: 18 }} style={{ originX: "82px", originY: "44px" }}>
            <circle cx={82} cy={44} r={13} fill="#a33424" />
            <circle cx={82} cy={44} r={9.5} fill="none" stroke="#e98a77" strokeWidth={1.3} />
            <text x={82} y={48} textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontSize={11} fontWeight={700} fill="#fde8de">R</text>
          </motion.g>
        )}
      </AnimatePresence>
    </svg>
  );
}

export function CountersignStage({ config }: { config?: Config | null }) {
  const [sel, setSel] = React.useState(SCENARIOS[0].id);
  const scenario = SCENARIOS.find((s) => s.id === sel)!;
  const [scope, animate] = useAnimate();
  const reduce = useReducedMotion() ?? false;
  const stationRefs = React.useRef<Record<StationId, HTMLDivElement | null>>({ agent: null, guardian: null, risk: null, vault: null });
  const [active, setActive] = React.useState<StationId | null>(null);
  const [shown, setShown] = React.useState<Step[]>([]);
  const [seals, setSeals] = React.useState({ g: false, r: false });
  const [stamp, setStamp] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [shield, setShield] = React.useState(false);
  const runId = React.useRef(0);

  const center = (s: StationId) => {
    const el = stationRefs.current[s];
    const root = scope.current as HTMLElement | null;
    if (!el || !root) return { x: 0, y: 0 };
    const a = el.getBoundingClientRect(), b = root.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2 - 48, y: a.top - b.top - 112 };
  };

  const play = React.useCallback(async (sc: Scenario) => {
    const my = ++runId.current;
    const alive = () => my === runId.current;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
    setShown([]); setSeals({ g: false, r: false }); setStamp(null); setShield(false); setActive(null);
    const env = "[data-envelope]";
    const start = center("agent");
    await animate(env, { x: start.x, y: start.y - 120, rotate: -8, opacity: 0 }, { duration: 0 });
    if (!alive()) return;
    await animate(env, { y: start.y, rotate: 0, opacity: 1 }, reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 18 });
    for (const st of sc.steps) {
      if (!alive()) return;
      const p = center(st.at);
      setActive(st.at);
      if (st.at === "vault" && sc.ending === "bounce") setShield(true);
      await animate(env, { x: p.x, y: p.y, rotate: [0, st.at === "agent" ? 0 : 6, 0] }, reduce ? { duration: 0 } : { type: "spring", stiffness: 140, damping: 16, mass: 0.9 });
      if (!alive()) return;
      setShown((s) => [...s, st]);
      if (st.seal) { await wait(120); setSeals((s) => ({ ...s, [st.seal!]: true })); await wait(380); }
      if (st.stamp) setStamp({ text: st.stamp, ok: st.tone === "ok" });
      await wait(st.at === "agent" ? 650 : 900);
    }
    if (!alive()) return;
    if (sc.ending === "execute") {
      const v = center("vault");
      await animate(env, { y: v.y + 70, scale: 0.35, opacity: 0 }, reduce ? { duration: 0 } : { duration: 0.55, ease: [0.5, 0, 0.75, 0] });
    } else if (sc.ending === "bounce") {
      const v = center("vault");
      await animate(env, { x: v.x - 170, y: v.y - 90, rotate: -40 }, reduce ? { duration: 0 } : { duration: 0.42, ease: [0.2, 0.8, 0.4, 1] });
      await animate(env, { y: v.y + 340, rotate: -160, opacity: 0 }, reduce ? { duration: 0 } : { duration: 0.75, ease: [0.55, 0, 1, 0.45] });
    } else {
      const here = center(sc.steps[sc.steps.length - 1].at);
      await animate(env, { y: here.y + 300, rotate: 70, opacity: 0 }, reduce ? { duration: 0 } : { duration: 0.8, ease: [0.55, 0, 1, 0.45] });
    }
    if (alive()) setActive(null);
  }, [animate, reduce]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const t = setTimeout(() => play(scenario), 60);
    return () => clearTimeout(t);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div role="radiogroup" aria-label="Scenarios" className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
        {SCENARIOS.map((s) => {
          const on = s.id === sel;
          return (
            <button
              key={s.id}
              role="radio"
              aria-checked={on}
              onClick={() => (on ? play(s) : setSel(s.id))}
              className={cn("group relative min-w-[170px] rounded-2xl px-4 py-3 text-left transition-colors", on ? "text-fog" : "text-fog/50 hover:text-fog/80")}
            >
              {on && <motion.span layoutId="cs-pill" className="absolute inset-0 rounded-2xl bg-panel-2 ring-1 ring-mint/35" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              <span className="relative block font-display text-[17px] font-semibold tracking-tight">{s.name}</span>
              <span className={cn("relative block font-mono text-[11px]", on ? "text-mint" : "text-dim")}>{s.sub}</span>
              {on && <Play aria-hidden className="absolute top-3.5 right-3 size-3.5 text-mint/70" />}
            </button>
          );
        })}
        <p className="hidden px-4 pt-2 text-[12px] text-dim lg:block">Click the active scenario to replay it.</p>
      </div>

      <div>
        <div ref={scope} className="paper-stage grain relative h-[300px] sm:h-[330px]">
          {/* conveyor */}
          <div className="absolute inset-x-[6%] top-[64%] h-[3px] rounded-full bg-paper-ink/15" />
          <div className="absolute inset-x-[6%] top-[64%] grid grid-cols-4">
            {STATIONS.map((s) => {
              const on = active === s.id;
              const addr = s.key(config);
              return (
                <div key={s.id} ref={(el) => { stationRefs.current[s.id] = el; }} className="flex flex-col items-center">
                  <motion.div
                    animate={on ? { scale: 1.08, y: -4 } : { scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20 }}
                    className={cn(
                      "relative -mt-7 grid size-14 place-items-center rounded-2xl border-2 shadow-[0_10px_20px_-10px_rgba(60,35,15,0.6)] transition-colors sm:size-16",
                      on ? "border-paper-ink bg-paper-ink text-paper" : "border-paper-ink/25 bg-[#fbf4ea] text-paper-ink",
                    )}
                  >
                    <s.Icon className="size-6 sm:size-7" strokeWidth={1.8} />
                    {s.id === "vault" && (
                      <AnimatePresence>
                        {shield && (
                          <motion.span
                            initial={{ scale: 0.4, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute -inset-3 rounded-[22px] border-[3px] border-coral/80 shadow-[0_0_24px_rgba(239,111,94,0.55)]"
                          />
                        )}
                      </AnimatePresence>
                    )}
                  </motion.div>
                  <div className="mt-2 text-center font-display text-[13px] font-semibold text-paper-ink sm:text-[14px]">{s.label}</div>
                  <div className="hidden text-center font-mono text-[10.5px] text-paper-dim sm:block">{s.role}</div>
                  <div className="text-center font-mono text-[10px] text-paper-dim/80">{short(addr)}</div>
                </div>
              );
            })}
          </div>
          <div data-envelope className="pointer-events-none absolute top-0 left-0 h-16 w-24" style={{ opacity: 0 }}>
            <Envelope seals={seals} />
          </div>
          <AnimatePresence>
            {stamp && (
              <motion.div
                key={stamp.text}
                initial={{ scale: 2.2, opacity: 0, rotate: -14 }}
                animate={{ scale: 1, opacity: 1, rotate: -8 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                className={cn(
                  "absolute top-5 right-5 rounded-lg border-[3px] px-3 py-1 font-mono text-[13px] font-bold tracking-wider uppercase sm:text-[15px]",
                  stamp.ok ? "border-mint-deep text-mint-deep" : "border-[#c2412f] text-[#c2412f]",
                )}
              >
                {stamp.text}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <ol className="mt-4 space-y-2" aria-live="polite">
          <AnimatePresence initial={false}>
            {shown.map((s, i) => (
              <motion.li
                key={`${sel}-${i}`}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex gap-3 rounded-xl border border-line/70 bg-panel/60 px-4 py-2.5 text-[14px]"
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", s.tone === "ok" ? "bg-mint" : s.tone === "bad" ? "bg-coral" : "bg-sky")} />
                <span className="text-mist"><b className="font-semibold text-fog">{STATIONS.find((x) => x.id === s.at)!.label}.</b> {s.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </div>
    </div>
  );
}
