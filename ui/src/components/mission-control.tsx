import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ArrowRightLeft, ExternalLink, KeyRound, Sparkles } from "lucide-react";
import { api, post } from "@/lib/api";
import { bps, num, short } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import type { Config } from "@/lib/types";
import { cn } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Card = { type: string; data: any };
type Msg = { role: "user" | "bot"; text: string; cards?: Card[]; src?: string; pending?: boolean };
type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<any> };
const eth = () => (window as unknown as { ethereum?: Eth }).ethereum;

const SESSION_KEY = "countersign.owner";
type Session = { address: string; issuedAt: string; signature: string };
const getSession = (): Session | null => {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as Session | null;
    return s && Date.now() - Date.parse(s.issuedAt) < 14 * 60_000 ? s : null;
  } catch { return null; }
};

type OwnerReq = { id: string; asset: string; percent: number; at: number; status: "QUEUED" | "RUNNING" | "EXECUTED" | "NOT_EXECUTED"; result: string | null; txHash: string | null };

/** Owner rebalance: the signed-in owner asks the agent to convert part of a position to USDT.
 *  It becomes an EXIT proposal that BOTH committee members must sign; the page never moves funds. */
function Rebalance({ session, signIn, explorer }: { session: Session | null; signIn: () => Promise<void>; explorer?: string }) {
  const [pct, setPct] = React.useState(50);
  const [reqs, setReqs] = React.useState<OwnerReq[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(() => api<{ requests: OwnerReq[] }>("/api/owner/requests").then((r) => setReqs(r.requests)).catch(() => undefined), []);
  React.useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  const active = reqs.find((r) => r.status === "QUEUED" || r.status === "RUNNING");
  const submit = async () => {
    const s = getSession();
    if (!s) return signIn();
    setBusy(true);
    setNote(null);
    try {
      const r = await post<any>("/api/owner/rebalance", { asset: "WHSK", percent: pct, auth: s });
      setNote(r.status === "QUEUED" ? r.note : `Not queued: ${r.reason}`);
      load();
    } catch (e) {
      setNote(`Not queued: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const label: Record<OwnerReq["status"], string> = { QUEUED: "waiting for the next tick", RUNNING: "committee is checking", EXECUTED: "executed on-chain", NOT_EXECUTED: "not executed" };
  return (
    <div className="rounded-2xl border border-mint/40 bg-mint/[0.06] p-4">
      <div className="flex items-center gap-2 font-display font-semibold"><ArrowRightLeft className="size-4 text-mint" /> Rebalance to USDT</div>
      <p className="mt-1 text-[13px] text-mist">Ask the agent to convert part of the vault's WHSK to USDT. It becomes an exit proposal that the Guardian <em>and</em> the Risk Officer must both sign; the vault re-checks the TWAP floor. Funds never leave the vault.</p>
      <div className="mt-3 flex items-center gap-3">
        <input type="range" min={10} max={100} step={5} value={pct} onChange={(e) => setPct(Number(e.target.value))} aria-label="Share of WHSK to convert" className="flex-1 accent-[#3dd6a3]" />
        <span className="tnum w-12 text-right font-mono text-[13px]">{pct}%</span>
      </div>
      <Button size="sm" className="mt-3 w-full" disabled={busy || !!active} onClick={submit}>
        {session ? (active ? "Request in progress…" : `Convert ${pct}% of WHSK`) : "Owner sign-in to request"}
      </Button>
      {note && <p className="mt-2 text-[12px] text-mist">{note}</p>}
      {reqs.slice(0, 3).map((r) => (
        <div key={r.id} className="mt-2 rounded-xl bg-ink-2/70 px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-fog">{r.percent}% {r.asset} → USDT</span>
            <span className={cn("font-mono", r.status === "EXECUTED" ? "text-mint" : r.status === "NOT_EXECUTED" ? "text-coral" : "text-amber")}>{label[r.status]}</span>
          </div>
          {r.txHash && explorer && (
            <a href={`${explorer}/tx/${r.txHash}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-sky hover:underline">{short(r.txHash)} <ExternalLink className="size-3" /></a>
          )}
          {r.result && r.status !== "EXECUTED" && <div className="mt-1 text-dim">{r.result}</div>}
        </div>
      ))}
    </div>
  );
}

const CHIPS = ["How are we doing?", "Why aren't you trading?", "What if I buy 5 USDT of BTC now?", "Low risk, only trade ETH and BTC, stop loss 2%", "Max trade 3 USDT and stop for the day after losing 0.5"];

// Shown only on the public snapshot, and labelled as an example of the flow.
const EXAMPLE: Msg[] = [
  { role: "user", text: "Low risk, only trade ETH and BTC, stop loss 2%" },
  {
    role: "bot",
    text: "Here's the change. Every row is stricter than today, so after you sign in the agent can apply it itself with tighten().",
    cards: [{ type: "diff", data: { changed: true, tighterOnly: true, example: true, rows: [
      { label: "Risk appetite (tiers)", from: "A + B + C", to: "B only", direction: "stricter" },
      { label: "Assets", from: "WHSK, WETH, WBTC", to: "WETH, WBTC", direction: "stricter" },
      { label: "Stop-loss", from: "3%", to: "2%", direction: "stricter" },
    ], notes: ["Looser changes can only be signed by the owner's wallet (setMandate)."], howToApply: "agent applies via tighten()" } }],
    src: "example · run the agent locally to chat live",
  },
];

function Bubble({ m, onApply }: { m: Msg; onApply: (d: any, b: HTMLButtonElement) => void }) {
  if (m.role === "user")
    return <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-mint px-4 py-2.5 text-[14px] text-ink">{m.text}</motion.div>;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[92%]">
      <div className="rounded-2xl rounded-bl-md border border-line bg-ink-2/80 px-4 py-3 text-[14px] text-fog">
        {m.pending ? (
          <span className="inline-flex gap-1">
            {[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-mist" animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.12 }} />)}
          </span>
        ) : (
          <span className="whitespace-pre-wrap">{m.text}</span>
        )}
        {m.cards?.map((c, i) => <CardView key={i} c={c} onApply={onApply} />)}
      </div>
      {m.src && <div className="mt-1 pl-2 font-mono text-[10.5px] text-dim">{m.src}</div>}
    </motion.div>
  );
}

function CardView({ c, onApply }: { c: Card; onApply: (d: any, b: HTMLButtonElement) => void }) {
  const d = c.data ?? {};
  const box = "mt-3 rounded-xl border border-line/80 bg-panel/80 p-3 text-[13px]";
  if (d.error) return <div className={box}>{d.error}</div>;
  switch (c.type) {
    case "diff":
      if (!d.changed) return <div className={box}>No change versus the current mandate.</div>;
      return (
        <motion.div initial={{ opacity: 0, rotateX: -20, y: 10 }} animate={{ opacity: 1, rotateX: 0, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 22 }} className={box}>
          <div className="mb-2 flex items-center gap-2 font-semibold">Proposed mandate change <StatusBadge status={d.tighterOnly ? "TIGHTENED" : "WARNING"} /></div>
          <div className="grid gap-1.5">
            {d.rows.map((r: any, i: number) => (
              <motion.div key={r.label} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.08 }} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2">
                <span className="truncate text-mist">{r.label}</span>
                <span className="font-mono text-[12px] text-dim line-through">{r.from}</span>
                <span className="text-dim">→</span>
                <span className="font-mono text-[12px] font-semibold text-mint">{r.to}</span>
              </motion.div>
            ))}
          </div>
          {d.notes?.map((n: string) => <div key={n} className="mt-2 text-[12px] text-dim">• {n}</div>)}
          {!d.example && (
            <Button size="sm" className="mt-3" onClick={(e) => onApply(d, e.currentTarget)}>
              {d.tighterOnly ? "Confirm — agent applies via tighten()" : "Sign as owner — setMandate()"}
            </Button>
          )}
        </motion.div>
      );
    case "whatif": {
      const e = d.economics ?? {};
      return (
        <div className={box}>
          <div className="flex items-center gap-2"><b>What-if</b> {d.question} → <StatusBadge status={d.decision} /></div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 font-mono text-[12px]">
            <span className="text-dim">expected net</span><span className={(e.expectedNetValueUsdt ?? 0) > 0 ? "text-mint" : "text-coral"}>{num(e.expectedNetValueUsdt, 4)} USDT</span>
            <span className="text-dim">edge</span><span>{bps(e.edgeBps)}</span>
            <span className="text-dim">failed checks</span><span>{(d.failed ?? []).map((f: any) => f.name).join(", ") || "none"}</span>
          </div>
          <div className="mt-1 text-[12px] text-dim">{d.note}</div>
        </div>
      );
    }
    case "positions":
      return <div className={box}>Vault {d.paused ? "paused" : "active"} · {num(d.usdt, 4)} USDT cash · total ≈ {num(d.totalValueUsdt, 4)} USDT · {d.positions?.length ? d.positions.map((p: any) => `${p.asset} ${num(p.unrealizedPct, 2)}%`).join(", ") : "no open positions"}</div>;
    case "performance":
      return <div className={box}>fills {d.trades} · net {num(d.netPnlUsdt, 4)} USDT (realized {num(d.realizedPnlUsdt, 4)} − gas {num(d.gasUsdt, 4)}) · Brier {d.predictions?.brier ?? "—"}</div>;
    case "market":
      return <div className={box}>{d.assets?.map((a: any) => <div key={a.asset} className="flex gap-2"><span className="w-12 font-mono">{a.asset}</span><StatusBadge status={a.status} /><span className="font-mono text-mist">{bps(a.premiumBps)}</span></div>)}</div>;
    case "why":
      return <div className={box}>{d.reasons?.length ? d.reasons.map((r: string) => <div key={r}>• {r}</div>) : "No blocker on the vault."}</div>;
    default:
      return null;
  }
}

export function MissionControl({ config, staticMode }: { config?: Config | null; staticMode: boolean }) {
  const [msgs, setMsgs] = React.useState<Msg[]>([
    { role: "bot", text: "I'm Mission Control. Ask how the agent is doing, why it's waiting, or a what-if. Or tell me how to trade: size, frequency, risk, assets, stop-loss. I only propose; the owner confirms." },
  ]);
  const [input, setInput] = React.useState("");
  const [session, setSession] = React.useState<Session | null>(getSession);
  const history = React.useRef<{ role: string; content: string }[]>([]);
  const logRef = React.useRef<HTMLDivElement>(null);
  const played = React.useRef(false);

  React.useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [msgs]);

  // On the public snapshot, play the labelled example once the panel is on screen.
  React.useEffect(() => {
    if (!staticMode || played.current) return;
    const el = logRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || played.current) return;
      played.current = true;
      setTimeout(() => setMsgs((m) => [...m, EXAMPLE[0]]), 400);
      setTimeout(() => setMsgs((m) => [...m, { role: "bot", text: "", pending: true }]), 900);
      setTimeout(() => setMsgs((m) => [...m.filter((x) => !x.pending), EXAMPLE[1]]), 2100);
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [staticMode]);

  const add = (m: Msg) => setMsgs((s) => [...s, m]);
  const send = async (text: string) => {
    if (!text.trim()) return;
    add({ role: "user", text });
    if (staticMode) {
      add({ role: "bot", text: "Live chat runs against the agent on the owner's machine. This public page is a published snapshot, so it can't answer. Run the agent locally (see the README) to chat, ask what-if questions and change the mandate.", src: "public snapshot" });
      return;
    }
    history.current.push({ role: "user", content: text });
    setMsgs((s) => [...s, { role: "bot", text: "", pending: true }]);
    try {
      const r = await post<{ reply: string; cards?: Card[]; source: string; note?: string }>("/api/copilot", { messages: history.current });
      history.current.push({ role: "assistant", content: r.reply });
      setMsgs((s) => [...s.filter((x) => !x.pending), { role: "bot", text: r.reply, cards: r.cards, src: `${r.source === "llm" ? "Claude · tools on live data" : "rules (no LLM key configured)"}${r.note ? ` · ${r.note}` : ""}` }]);
    } catch (e) {
      setMsgs((s) => [...s.filter((x) => !x.pending), { role: "bot", text: `Error: ${(e as Error).message}` }]);
    }
  };

  const signIn = async () => {
    const w = eth();
    if (!w) return add({ role: "bot", text: "No browser wallet found. Install MetaMask or Rabby; a Ledger can connect through them." });
    try {
      const [address] = (await w.request({ method: "eth_requestAccounts" })) as string[];
      const issuedAt = new Date().toISOString();
      const { message } = await api<{ message: string }>(`/api/owner/message?issuedAt=${encodeURIComponent(issuedAt)}`);
      const signature = (await w.request({ method: "personal_sign", params: [message, address] })) as string;
      const s = { address, issuedAt, signature };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      setSession(s);
      add({ role: "bot", text: `Signed in as ${short(address)}. That signature moves no funds; it lets you confirm mandate changes for 15 minutes.` });
    } catch (e) {
      add({ role: "bot", text: `Sign-in cancelled: ${(e as Error).message}` });
    }
  };

  const apply = async (d: any, btn: HTMLButtonElement) => {
    const s = getSession();
    if (!s) return add({ role: "bot", text: "Sign in as the owner first (button above the chat)." });
    btn.disabled = true;
    try {
      const r = await post<any>("/api/mandate/apply", { proposed: d.proposed, auth: s });
      if (r.status === "APPLIED") add({ role: "bot", text: `Applied on-chain by the agent via tighten(): ${r.txHash}` });
      else if (r.status === "OWNER_SIGNATURE_REQUIRED") {
        const w = eth()!;
        const hex = `0x${(config?.chainId ?? 177).toString(16)}`;
        await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        const hash = await w.request({ method: "eth_sendTransaction", params: [{ from: s.address, to: r.tx.to, data: r.tx.data }] });
        add({ role: "bot", text: `Owner transaction sent (setMandate): ${hash}` });
      } else add({ role: "bot", text: `Not applied: ${r.reason}` });
    } catch (e) {
      add({ role: "bot", text: `Not applied: ${(e as Error).message}` });
    } finally {
      btn.disabled = false;
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex h-[560px] flex-col overflow-hidden rounded-3xl border border-line/80 bg-panel/70">
        <div className="flex items-center justify-between border-b border-line/70 px-5 py-3">
          <div className="flex items-center gap-2 font-display font-semibold"><Sparkles className="size-4 text-mint" /> Mission Control</div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-dim">{staticMode ? "public snapshot" : config?.copilot === "llm" ? "Claude with tools" : "rules mode"}</span>
            {!staticMode && (
              <Button size="sm" variant="ghost" onClick={signIn}><KeyRound className="size-3.5" />{session ? `Owner ${short(session.address)}` : "Owner sign-in"}</Button>
            )}
          </div>
        </div>
        <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4" aria-live="polite">
          <AnimatePresence initial={false}>
            {msgs.map((m, i) => <Bubble key={i} m={m} onApply={apply} />)}
          </AnimatePresence>
        </div>
        <div className="flex gap-1.5 overflow-x-auto px-5 pb-2">
          {CHIPS.map((c) => (
            <button key={c} onClick={() => send(c)} className="shrink-0 rounded-full border border-line px-3 py-1 text-[12px] text-mist transition-colors hover:border-mint/50 hover:text-fog">{c}</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); const v = input; setInput(""); send(v); }} className="flex gap-2 border-t border-line/70 p-3">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about P&L, or tell the agent how to trade…" className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-ink-2 px-4 text-[14px] text-fog placeholder:text-dim focus:border-mint/60 focus:outline-none" />
          <Button aria-label="Send" className="size-11 p-0"><ArrowUp className="size-4" /></Button>
        </form>
      </div>
      <div className="space-y-3">
        {!staticMode && <Rebalance session={session} signIn={signIn} explorer={config?.explorer} />}
        {[
          ["Stricter changes", "Smaller size, slower, fewer assets, lower risk. The agent applies them on-chain via tighten() once the owner is signed in."],
          ["Looser changes", "Only the owner's wallet can sign them (setMandate). The copilot never holds owner power."],
          ["What-if questions", "Run the real Guardian in dry-run against live quotes. Nothing is ever signed."],
          ["Risk appetite", "Low = spread trades with ≥ 60 bps edge · medium = + arbitrage · high = + AI directional trades."],
        ].map(([h, t], i) => (
          <motion.div key={h} initial={{ opacity: 0, x: 12 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }} className={cn("rounded-2xl border border-line/80 bg-panel/60 p-4")}>
            <div className="font-display font-semibold">{h}</div>
            <div className="mt-1 text-[13.5px] text-mist">{t}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
