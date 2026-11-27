import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { KeyRound, Loader2, RotateCw, ScanSearch, ShieldCheck, Swords, UserX } from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { short } from "@/lib/format";
import { ATTACKS, DEMO_TESTNET_VAULT, EXPLORERS, RPCS, type AttackResult, type RunInfo, type Who } from "@/lib/attacks";
import type { Config } from "@/lib/types";

const WHO_ICON: Record<Who, typeof KeyRound> = { "agent key": KeyRound, "guardian key": ScanSearch, stranger: UserX };
const WHO_COL: Record<Who, string> = { "agent key": "#ef6f5e", "guardian key": "#a78bfa", stranger: "#6cb4ff" };
const revert = (r: AttackResult) => `${r.name ?? "reverted"}${r.args?.length ? `(${r.args.join(", ")})` : ""}`;

type Shot = { key: number; r: AttackResult };

function Stage({ shots, hits, blocked, total, onShotDone }: { shots: Shot[]; hits: number; blocked: number; total: number; onShotDone: (k: number) => void }) {
  const reduce = useReducedMotion() ?? false;
  const pct = total ? blocked / total : 0;
  const C = 2 * Math.PI * 34;
  return (
    <svg viewBox="0 0 600 320" className="absolute inset-0 h-full w-full" role="img" aria-label={`${blocked} of ${total} attacks blocked`}>
      <defs>
        <radialGradient id="ba-door" cx={0.4} cy={0.35} r={0.75}>
          <stop offset={0} stopColor="#5b4535" /><stop offset={0.7} stopColor="#3b2b20" /><stop offset={1} stopColor="#2a1e16" />
        </radialGradient>
        <radialGradient id="ba-pool"><stop offset={0} stopColor="rgba(255,248,236,0.55)" /><stop offset={1} stopColor="rgba(255,248,236,0)" /></radialGradient>
      </defs>
      <ellipse cx={470} cy={268} rx={150} ry={26} fill="url(#ba-pool)" />
      <ellipse cx={478} cy={262} rx={86} ry={12} fill="rgba(70,40,18,0.22)" />
      {/* launcher */}
      <g transform="translate(70 236)">
        <rect x={-30} y={0} width={60} height={22} rx={6} fill="#3b2b20" />
        <rect x={-6} y={-26} width={12} height={30} rx={4} fill="#5b4535" transform="rotate(38 0 0)" />
        <text x={0} y={42} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={10} fontWeight={600} fill="#7a6250" letterSpacing={1}>ATTACKER</text>
      </g>
      {/* vault door + shield */}
      <g transform="translate(478 160)">
        <motion.circle
          key={hits}
          r={100}
          fill="none"
          strokeWidth={6}
          initial={hits ? { stroke: "#ef6f5e", opacity: 1, scale: 1.06 } : false}
          animate={{ stroke: "#3dd6a3", opacity: 0.55, scale: 1 }}
          transition={{ duration: 0.6 }}
          style={{ filter: "drop-shadow(0 0 10px rgba(61,214,163,0.5))" }}
        />
        <circle r={86} fill="url(#ba-door)" stroke="#20160f" strokeWidth={3} />
        <circle r={74} fill="none" stroke="#6b4d38" strokeWidth={2} strokeDasharray="4 6" />
        {Array.from({ length: 8 }, (_, i) => (
          <circle key={i} cx={Math.cos((i / 8) * Math.PI * 2) * 62} cy={Math.sin((i / 8) * Math.PI * 2) * 62} r={5} fill="#8a6a50" />
        ))}
        <circle r={34} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={8} />
        <motion.circle
          r={34}
          fill="none"
          stroke="#3dd6a3"
          strokeWidth={8}
          strokeLinecap="round"
          transform="rotate(-90)"
          strokeDasharray={C}
          animate={{ strokeDashoffset: C * (1 - pct) }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
        <text y={4} textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontSize={22} fontWeight={700} fill="#fbf4ea">{blocked}</text>
        <text y={20} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={9} fill="#d9c19f">of {total}</text>
      </g>
      {/* projectiles */}
      {shots.map(({ key, r }) => {
        const Icon = WHO_ICON[r.who];
        return (
          <motion.g
            key={key}
            initial={{ x: 70, y: 220, rotate: 0, opacity: 1 }}
            animate={
              reduce
                ? { x: 360, y: 150, opacity: [1, 0] }
                : { x: [70, 250, 372, 318, 290], y: [220, 50, 150, 120, 360], rotate: [0, 160, 260, 320, 520], opacity: [1, 1, 1, 1, 0.9] }
            }
            transition={reduce ? { duration: 0.4 } : { duration: 1.35, times: [0, 0.38, 0.6, 0.72, 1], ease: ["easeOut", "easeIn", "easeOut", "easeIn"] }}
            onAnimationComplete={() => onShotDone(key)}
          >
            <circle r={17} fill={WHO_COL[r.who]} stroke="#2b2018" strokeWidth={2} />
            <foreignObject x={-9} y={-9} width={18} height={18}>
              <Icon className="size-[18px] text-[#2b2018]" strokeWidth={2.4} />
            </foreignObject>
          </motion.g>
        );
      })}
      {shots.map(({ key, r }) => (
        <motion.g key={`l${key}`} initial={{ opacity: 0, y: 0 }} animate={{ opacity: [0, 1, 1, 0], y: [-0, -10, -24, -36] }} transition={{ duration: 1.9, delay: reduce ? 0 : 0.8, times: [0, 0.15, 0.7, 1] }}>
          <rect x={250} y={58} width={Math.min(300, 14 + revert(r).length * 7.4)} height={26} rx={7} fill="#2b2018" />
          <text x={258} y={75} fontFamily="JetBrains Mono, monospace" fontSize={12} fontWeight={600} fill={r.blocked ? "#3dd6a3" : "#ef6f5e"}>{revert(r)}</text>
        </motion.g>
      ))}
    </svg>
  );
}

export function BreakItArena({ config }: { config?: Config | null }) {
  const target = config?.v2Vault ?? (config?.chainId === 177 ? config.vault : null);
  const [net, setNet] = React.useState<number>(target ? config!.chainId : 133);
  const [vault, setVault] = React.useState<string>(target ?? DEMO_TESTNET_VAULT);
  React.useEffect(() => {
    if (target && config) { setNet(config.chainId); setVault(target); }
  }, [target, config?.chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [results, setResults] = React.useState<Record<number, AttackResult>>({});
  const [info, setInfo] = React.useState<RunInfo | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [shots, setShots] = React.useState<Shot[]>([]);
  const [hits, setHits] = React.useState(0);
  const [focus, setFocus] = React.useState<number | null>(null);
  const queue = React.useRef<AttackResult[]>([]);
  const firing = React.useRef(false);
  const shotKey = React.useRef(0);

  const fireNext = React.useCallback(() => {
    const r = queue.current.shift();
    if (!r) { firing.current = false; return; }
    firing.current = true;
    const key = ++shotKey.current;
    setShots((s) => [...s.slice(-3), { key, r }]);
    setFocus(r.id);
    setTimeout(() => {
      setHits((h) => h + 1);
      setResults((m) => ({ ...m, [r.id]: r }));
    }, 800);
    setTimeout(fireNext, 620);
  }, []);
  const enqueue = (r: AttackResult) => { queue.current.push(r); if (!firing.current) fireNext(); };

  const run = async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) return setError("Enter a v2 vault address.");
    setError(null); setResults({}); setInfo(null); setRunning(true); queue.current = []; setHits(0);
    try {
      const { runAttacks } = await import("@/lib/breakit"); // viem loads only when someone attacks
      await runAttacks({ rpc: RPCS[net], chainId: net, vault: vault as Address }, setInfo, enqueue);
    } catch (e) {
      setError(`Could not reach the chain: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setRunning(false);
    }
  };

  // ?run=1 starts the attacks on load (used for demos and shared links)
  const autorun = React.useRef(false);
  React.useEffect(() => {
    if (autorun.current || !target || new URLSearchParams(location.search).get("run") !== "1") return;
    autorun.current = true;
    run();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = Object.values(results);
  const blocked = done.filter((r) => r.blocked).length;
  const explorer = EXPLORERS[net];
  const focused = focus !== null ? results[focus] : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div>
        <div className="paper-stage grain relative aspect-[15/8] w-full">
          <Stage shots={shots} hits={hits} blocked={blocked} total={ATTACKS.length} onShotDone={(k) => setShots((s) => s.filter((x) => x.key !== k))} />
          <AnimatePresence>
            {!running && done.length === ATTACKS.length && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute bottom-4 left-4 rounded-xl bg-paper-ink/90 px-3 py-2 font-mono text-[12px] text-paper">
                {blocked === ATTACKS.length ? "every attack blocked by the contract itself" : `${ATTACKS.length - blocked} attack(s) not blocked`}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={run} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : done.length ? <RotateCw className="size-4" /> : <Swords className="size-4" />}
            {running ? "Attacking the live vault…" : done.length ? "Run all 15 again" : "Run all 15 attacks"}
          </Button>
          <select value={net} onChange={(e) => { const n = Number(e.target.value); setNet(n); if (n === 133) setVault(DEMO_TESTNET_VAULT); else if (target) setVault(target); }} className="h-12 rounded-2xl border border-line bg-panel px-3 text-sm text-fog">
            <option value={177}>HSK Mainnet</option>
            <option value={133}>HSK Testnet</option>
          </select>
          <input value={vault} onChange={(e) => setVault(e.target.value.trim())} spellCheck={false} aria-label="Vault address" className="h-12 min-w-0 flex-1 rounded-2xl border border-line bg-panel px-3 font-mono text-[12px] text-mist" />
        </div>
        <p className="mt-2 text-[12.5px] text-dim">
          Real <code className="font-mono text-mist">eth_call</code>s from your browser against{" "}
          <a className="font-mono text-sky hover:underline" href={`${explorer}/address/${vault}`} target="_blank" rel="noreferrer">{short(vault)}</a>
          {info && <> · committee {info.threshold}-of-{info.guardians.length} · agent <span className="font-mono">{short(info.agent)}</span></>}. No wallet, no gas; attacker keys are made here and thrown away.
        </p>
        {error && <p className="mt-2 text-[13px] text-coral">{error}</p>}
        <AnimatePresence mode="wait">
          {focused && (
            <motion.div key={focused.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-2xl border border-line bg-panel/70 p-4">
              <div className="font-display text-[15px] font-semibold">{focused.title}</div>
              <div className="mt-1 text-[13.5px] text-mist">{focused.blurb}</div>
              <div className="mt-2 font-mono text-[12.5px]">
                vault said <span className={focused.blocked ? "text-mint" : "text-coral"}>{revert(focused)}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ol className="space-y-1">
        {ATTACKS.map((a) => {
          const r = results[a.id];
          const Icon = WHO_ICON[a.who];
          return (
            <li key={a.id}>
              <button
                onClick={() => { if (r) { setFocus(a.id); enqueue(r); } }}
                disabled={!r}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                  focus === a.id ? "bg-panel-2 ring-1 ring-mint/30" : "hover:bg-panel/70",
                )}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: `${WHO_COL[a.who]}22`, color: WHO_COL[a.who] }}>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-fog">{a.title}</span>
                  <span className="block truncate font-mono text-[11px] text-dim">{r ? revert(r) : `as ${a.who}`}</span>
                </span>
                <AnimatePresence mode="popLayout">
                  {r ? (
                    <motion.span key="r" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 500, damping: 18 }}
                      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ring-1", r.blocked ? "bg-mint/12 text-mint ring-mint/30" : "bg-coral/12 text-coral ring-coral/30")}>
                      <ShieldCheck className="size-3" /> {r.blocked ? "BLOCKED" : "ALLOWED"}
                    </motion.span>
                  ) : (
                    <span key="p" className="font-mono text-[11px] text-dim">{running ? "…" : "ready"}</span>
                  )}
                </AnimatePresence>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
