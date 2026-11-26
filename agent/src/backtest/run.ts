import { writeFileSync } from "node:fs";
import { MAINNET } from "../config.js";
import { baseIsToken0 } from "../modules/market-data/pools.js";
import { loadHistory, DAYS } from "./fetch.js";
import { buildSeries, LIVE_DEFAULTS, replay, type Result } from "./replay.js";

/** `pnpm backtest` — replays the live rules over the last DAYS days and writes research/backtest.md. */
const h = await loadHistory();
const half = h.startTs + Math.floor((h.endTs - h.startTs) / 2);
const series = Object.fromEntries(
  MAINNET.pools.map((p) => {
    const b0 = baseIsToken0(p);
    const [d0, d1] = b0 ? [p.base.decimals, p.quote.decimals] : [p.quote.decimals, p.base.decimals];
    return [p.asset, buildSeries(h.pools[p.asset]!, h.cex[p.asset]!, d0, d1, b0, h.startTs, h.endTs)];
  }),
);
const hskSeries = series.WHSK!;
const hskAt = (t: number) => {
  const i = hskSeries.t.findIndex((x) => x >= t);
  return hskSeries.dex[i < 0 ? hskSeries.dex.length - 1 : i] ?? 0.08;
};

type Row = { asset: string; period: string; gate: string; r: Result };
const rows: Row[] = [];
for (const asset of ["WHSK", "WETH", "WBTC"]) {
  const s = series[asset]!;
  for (const [period, lo, hi] of [["full 30 d", h.startTs, h.endTs], ["first half", h.startTs, half], ["second half", half, h.endTs]] as const) {
    const idx = s.t.map((t, i) => (t >= lo && t < hi ? i : -1)).filter((i) => i >= 0);
    const sub = { t: idx.map((i) => s.t[i]!), dex: idx.map((i) => s.dex[i]!), twap30: idx.map((i) => s.twap30[i]!), ref: idx.map((i) => s.ref[i]!) };
    rows.push({ asset, period, gate: "Countersign (fixed gate: half-gap exit)", r: replay(asset, sub, (i) => hskAt(sub.t[i]!), { ...LIVE_DEFAULTS, gateOn: true, gateMode: "half-gap" }) });
    rows.push({ asset, period, gate: "first gate (full convergence) — the flaw", r: replay(asset, sub, (i) => hskAt(sub.t[i]!), { ...LIVE_DEFAULTS, gateOn: true, gateMode: "full-convergence" }) });
    rows.push({ asset, period, gate: "rules alone (no gate)", r: replay(asset, sub, (i) => hskAt(sub.t[i]!), { ...LIVE_DEFAULTS, gateOn: false }) });
  }
}

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
const lines = [
  `# Backtest — the live rules replayed on ${DAYS} days of HSK mainnet data`,
  "",
  `Generated ${new Date().toISOString()} by \`pnpm backtest\` (agent/src/backtest). Window: ${new Date(h.startTs * 1000).toISOString().slice(0, 16)} → ${new Date(h.endTs * 1000).toISOString().slice(0, 16)} UTC.`,
  "",
  `Data: every Swap event on the three HSKSwap pools (WHSK ${h.pools.WHSK!.length}, WETH ${h.pools.WETH!.length}, WBTC ${h.pools.WBTC!.length} swaps) and Gate.io 5-minute candles. Parameters are the **live defaults, untuned**: ${LIVE_DEFAULTS.sizeUsdt} USDT per trade, entry band = pool fee + min edge + buffer = ${LIVE_DEFAULTS.feeBps + LIVE_DEFAULTS.minEdgeBps + LIVE_DEFAULTS.bufferBps} bps, target = half the gap, invalidation = max(150 bps, gap), ${LIVE_DEFAULTS.expiryHours} h expiry, ${LIVE_DEFAULTS.stopLossPct}% TWAP stop-loss, gas ${LIVE_DEFAULTS.gasUnitsPerSwap.toLocaleString()} units at ${LIVE_DEFAULTS.gasGwei} gwei per swap.`,
  "",
  "| Asset | Period | Policy | Candidates | Refused by gate | Round trips | Wins / losses | Net P&L after fees + gas (USDT) | Gas (USDT) | Max drawdown (USDT) |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map(({ asset, period, gate, r }) => `| ${asset} | ${period} | ${gate} | ${r.candidates} | ${r.refusedByGate} | ${r.trades.length} | ${r.wins} / ${r.losses} | ${fmt(r.netUsdt)} | ${r.gasUsdt.toFixed(4)} | ${r.maxDrawdownUsdt.toFixed(4)} |`),
  "",
  "## Exit reasons (full window, Countersign policy)",
  "",
  ...["WHSK", "WETH", "WBTC"].map((a) => {
    const r = rows.find((x) => x.asset === a && x.period === "full 30 d" && x.gate.startsWith("Countersign"))!.r;
    const by = r.trades.reduce<Record<string, number>>((m, t) => ((m[t.exitReason] = (m[t.exitReason] ?? 0) + 1), m), {});
    return `- **${a}**: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") || "no trades"}`;
  }),
  "",
  "## What the backtest found (and what we fixed)",
  "",
  "The first Guardian valued a spread entry as if the gap closed **completely**, while the strategy's own exit target assumes only **half** of it closes. On these 0.30%-fee pools a half-gap exit rarely pays two fees plus ~$0.024 of gas, so the first gate still approved losing trades (it only cut losses vs. no gate). The live Guardian now values every entry at the strategy's own exit (half the gap) after exit fee, impact and gas both ways — the row marked *fixed gate*. The rows marked *the flaw* are kept so the improvement is visible.",
  "",
  "## Honest reading",
  "",
  "- Nothing was tuned on this data, so there is no in-sample/out-of-sample gap to hide; the two halves are shown to judge stability.",
  "- A small number of round trips cannot establish an edge. We make **no profitability claim**; the backtest shows what the gate does with costs, not that the strategy beats the market.",
  "- Simplifications: last-swap pool price (pools are stale between swaps), a single exchange as reference (live uses the median of 3–4 with outlier rejection), no price impact (≤ 3 bps at 5 USDT, measured live), fills at pool price ± 0.30%.",
];
writeFileSync("../research/backtest.md", lines.join("\n") + "\n");
console.log(lines.slice(6, 6 + 2 + rows.length).join("\n"));
