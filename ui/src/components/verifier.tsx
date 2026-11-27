import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EXPLORERS } from "@/lib/attacks";
import type { VerifyCheck, VerifyInfo } from "@/lib/verify-trade";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "First mainnet trade", chainId: 177, hash: "0x6e02064a32009d8636bd60c002d9c7ee0fe4b4b88235cda6b7b8c8b769d74584" },
  { label: "Testnet committee trade", chainId: 133, hash: "0x4cbbc0e4a64e95505e3fd92ba43a6f25ed84e04df47d432d95852bd5ea65c24f" },
];

const fmt = (v: bigint | undefined, d: number) => (v === undefined ? "—" : (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 6 }));

/** "Don't trust our CLI either": the 14 checks of `pnpm verify trade`, run against the chain from this page. */
export function Verifier() {
  const initial = React.useMemo(() => {
    const q = new URLSearchParams(location.search);
    const h = q.get("verify");
    return h && /^0x[0-9a-fA-F]{64}$/.test(h) ? { hash: h, chainId: q.get("chain") === "133" ? 133 : 177 } : null;
  }, []);
  const [hash, setHash] = React.useState(initial?.hash ?? PRESETS[0].hash);
  const [chainId, setChainId] = React.useState(initial?.chainId ?? 177);
  const [checks, setChecks] = React.useState<VerifyCheck[]>([]);
  const [info, setInfo] = React.useState<VerifyInfo | null>(null);
  const [state, setState] = React.useState<"idle" | "running" | "done" | "error">("idle");
  const [err, setErr] = React.useState<string | null>(null);

  const run = React.useCallback(async (h = hash, c = chainId) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(h.trim())) {
      setErr("Paste a transaction hash: 0x followed by 64 hex characters.");
      setState("error");
      return;
    }
    setChecks([]);
    setInfo(null);
    setErr(null);
    setState("running");
    try {
      const { verifyTradeInBrowser } = await import("@/lib/verify-trade"); // viem loads only when someone verifies
      const r = await verifyTradeInBrowser(c, h.trim() as `0x${string}`, (x) => setChecks((s) => [...s, x]));
      setInfo(r.info);
      setState("done");
    } catch (e) {
      setErr((e as Error).message.split("\n")[0] ?? "lookup failed");
      setState("error");
    }
  }, [hash, chainId]);

  React.useEffect(() => {
    if (initial) run(initial.hash, initial.chainId);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const passed = checks.filter((c) => c.pass).length;
  const ok = state === "done" && checks.length > 0 && passed === checks.length;
  const exitSell = info?.tier === 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="rounded-3xl border border-line/80 bg-panel/70 p-5">
        <div className="flex items-center gap-2 font-display text-lg font-semibold"><ShieldCheck className="size-5 text-mint" /> Verify any trade</div>
        <p className="mt-1 text-[13.5px] text-mist">Paste a Countersign trade. Your browser decodes it, recovers who signed the permit, and checks them against the vault's committee at the block before. No wallet, no server of ours.</p>
        <div className="mt-4 flex gap-1.5 rounded-xl bg-ink-2 p-1 text-[12.5px]">
          {[177, 133].map((c) => (
            <button key={c} onClick={() => setChainId(c)} className={cn("flex-1 rounded-lg px-3 py-1.5 transition-colors", chainId === c ? "bg-panel-2 text-fog" : "text-dim hover:text-mist")}>
              {c === 177 ? "HSK mainnet" : "HSK testnet"}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); run(); }} className="mt-3 flex gap-2">
          <input value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} aria-label="Transaction hash" className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-ink-2 px-3 font-mono text-[12px] text-fog focus:border-mint/60 focus:outline-none" />
          <Button disabled={state === "running"}>{state === "running" ? <Loader2 className="size-4 animate-spin" /> : "Verify"}</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.hash} onClick={() => { setHash(p.hash); setChainId(p.chainId); run(p.hash, p.chainId); }} className="rounded-full border border-line px-3 py-1 text-[12px] text-mist hover:border-mint/50 hover:text-fog">{p.label}</button>
          ))}
        </div>

        <AnimatePresence>
          {(ok || (state === "done" && !ok)) && (
            <motion.div initial={{ opacity: 0, scale: 0.9, rotate: -4 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}
              className={cn("mt-5 rounded-2xl border-2 p-4 text-center", ok ? "border-mint/70 bg-mint/[0.07]" : "border-coral/70 bg-coral/[0.07]")}>
              <div className={cn("font-display text-2xl font-bold tracking-wide", ok ? "text-mint" : "text-coral")}>{ok ? "VERIFIED" : "NOT VERIFIED"}</div>
              <div className="tnum font-mono text-[12.5px] text-mist">{passed}/{checks.length} checks passed</div>
              {info?.signers && (
                <div className="mt-3 grid gap-1 text-left font-mono text-[11.5px] text-mist">
                  <div>committee signers: <span className="text-fog">{info.signers.map((s) => `${s.slice(0, 6)}…${s.slice(-4)}`).join(" + ")}</span></div>
                  {info.amountOut !== undefined && (
                    <div>fill: <span className="text-fog">{exitSell ? `${fmt(info.amountIn, 18)} WHSK → ${fmt(info.amountOut, 6)} USDT` : `${fmt(info.amountIn, 6)} USDT in → ${fmt(info.amountOut, 18)} out`}</span></div>
                  )}
                </div>
              )}
              <a href={`${EXPLORERS[chainId]}/tx/${hash.trim()}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-mono text-[12px] text-sky hover:underline">open on the explorer <ExternalLink className="size-3" /></a>
            </motion.div>
          )}
        </AnimatePresence>
        {err && <p className="mt-4 rounded-xl bg-coral/10 px-3 py-2 text-[12.5px] text-coral">{err}</p>}
      </div>

      <div className="rounded-3xl border border-line/80 bg-ink-2/70 p-5 font-mono text-[12.5px]" aria-live="polite">
        <div className="mb-3 text-dim">$ pnpm verify trade {hash.slice(0, 10)}…{chainId === 133 ? " --testnet" : ""}</div>
        {checks.length === 0 && state !== "running" && <div className="text-dim">Press Verify. Each check appears as the chain answers it.</div>}
        <ol className="space-y-1.5">
          {checks.map((c, i) => (
            <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="flex items-start gap-2">
              {c.pass ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-mint" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-coral" />}
              <span className="min-w-0 flex-1">
                <span className={c.pass ? "text-fog" : "text-coral"}>{c.name}</span>
                {c.detail && <span className="ml-2 break-all text-dim">{c.detail}</span>}
              </span>
            </motion.li>
          ))}
          {state === "running" && <li className="flex items-center gap-2 text-dim"><Loader2 className="size-4 animate-spin" /> asking HSK Chain…</li>}
        </ol>
      </div>
    </div>
  );
}
