import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Address } from "viem";
import { MAINNET } from "../config.js";
import { makeClient } from "../common/chain.js";
import { Store } from "../common/store.js";
import { takeSnapshot } from "../modules/market-data/snapshot.js";
import { evaluateMarket } from "../modules/data-reliability/engine.js";
import { scanRadar } from "../modules/arbitrage/radar.js";
import { paperVaultState, readVaultState, usdt } from "../modules/vault/state.js";
import { evaluatePositions } from "../modules/positions/positions.js";
import { computeMetrics } from "../modules/strategy-health/health.js";

/**
 * Publishes the dashboard's data as static JSON for the public page (GitHub Pages).
 *   pnpm publish-site                 fresh market + radar + the local agent journal
 *   pnpm publish-site --market-only   fresh market + radar only (used by the scheduled Action; no keys, no DB)
 * Nothing here signs or sends anything.
 */
const OUT = resolve(process.env.SITE_DATA ?? "../web/data");
const marketOnly = process.argv.includes("--market-only");
const json = (name: string, data: unknown) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isFinite(v) ? null : v)));

mkdirSync(OUT, { recursive: true });
const client = makeClient(MAINNET);
const vault = (process.env.VAULT as Address | undefined) ?? null;
const snap = await takeSnapshot(client, MAINNET);
const health = evaluateMarket(snap, MAINNET.pools.map((p) => p.asset));
const ref = (a: string, f: number) => health.assets.find((x) => x.asset === a)?.reference ?? f;

json("prices", {
  evaluatedAt: health.evaluatedAt,
  assets: health.assets.map((a) => ({
    asset: a.asset, status: a.status, dexSpot: a.dexSpot, twap5m: a.twapShort, twap30m: a.twapLong, reference: a.reference, premiumBps: a.premiumBps,
    sources: a.sources.map((s) => ({ source: s.source, mid: s.mid, accepted: s.accepted, reason: s.reason })),
  })),
});
json("arbitrage", await scanRadar(client, MAINNET, ref("WHSK", 0.08), ref("WETH", 1700)));

const v = vault ? await readVaultState(client, MAINNET, vault).catch(() => paperVaultState(MAINNET)) : paperVaultState(MAINNET);
const store = !marketOnly && existsSync(process.env.COUNTERSIGN_DB ?? "./data/countersign.db") ? new Store() : null;
const preds = store?.predictions() ?? [];
const positions = evaluatePositions(MAINNET, v, health, preds, Math.floor(Date.now() / 1000));
const cash = usdt(v.quoteBalance, v.quoteDecimals);
const m = v.mandate;
json("portfolio", {
  vault: v.address, mode: v.mode, paused: v.paused, usdt: cash,
  totalValueUsdt: cash + positions.reduce((a, p) => a + (Number.isFinite(p.exitValueUsdt) ? p.exitValueUsdt : 0), 0),
  today: { volumeUsdt: usdt(v.dayVolume, v.quoteDecimals), realizedPnlUsdt: usdt(v.dayPnl, v.quoteDecimals) },
  mandate: {
    maxTradeUsdt: usdt(m.maxTradeQuote), dailyVolumeUsdt: usdt(m.dailyVolumeQuote), dailyLossUsdt: usdt(m.dailyLossQuote), maxExposureUsdt: usdt(m.maxExposureQuote),
    cooldownSec: m.cooldown, maxSlippageBps: m.maxSlippageBps, minEdgeBps: m.minEdgeBps, tiersMask: m.tiersMask, assetsMask: m.assetsMask, expiry: Number(m.expiry),
    stopLossBps: m.stopLossBps ?? 0, takeProfitBps: m.takeProfitBps ?? 0, maxDrawdownBps: m.maxDrawdownBps ?? 0,
  },
  committee: { guardians: v.guardians, threshold: v.threshold },
  positions: positions.map((p) => ({ ...p, qtyRaw: p.qtyRaw.toString() })),
});

json("config", {
  chainId: MAINNET.chainId,
  explorer: MAINNET.explorer,
  vault,
  v2Vault: v.guardians?.length ? vault : null,
  agent: process.env.AGENT ?? null,
  guardian: process.env.GUARDIAN ?? null,
  riskOfficer: process.env.RISK_OFFICER ?? null,
  owner: process.env.OWNER ?? null,
  contracts: { vaultImplementation: process.env.VAULT_IMPLEMENTATION ?? null, vaultFactory: MAINNET.vaultFactory, router: MAINNET.router },
  mode: process.env.AGENT_MODE ?? "shadow",
  copilot: "snapshot",
  publishedAt: Date.now(),
});

if (store) {
  const hsk = ref("WHSK", 0.08);
  json("health", computeMetrics(store.trades(), preds, store.txRecent(500), hsk));
  const decisions = store.recentDecisions(120);
  json("decisions", { decisions });
  for (const d of decisions.slice(0, 60)) {
    const full = store.decision(d.seq);
    if (full) json(`decision-${d.seq}`, full);
  }
  for (const a of ["WHSK", "WETH", "WBTC"]) json(`history-${a}`, { asset: a, points: store.history(a, 240) });
  json("transactions", { transactions: store.txRecent(100).map(({ payload: _p, ...t }) => t) });
  json("trades", { trades: store.trades() });
  json("predictions", { predictions: preds.map(({ payload: _p, ...x }) => x) });
} else {
  // keep previously published journal files; only create empty ones if none exist yet
  const empty: Record<string, unknown> = {
    health: computeMetrics([], [], [], 0.08), decisions: { decisions: [] }, transactions: { transactions: [] }, trades: { trades: [] }, predictions: { predictions: [] },
    "history-WHSK": { asset: "WHSK", points: [] }, "history-WETH": { asset: "WETH", points: [] }, "history-WBTC": { asset: "WBTC", points: [] },
  };
  for (const [k, val] of Object.entries(empty)) if (!existsSync(join(OUT, `${k}.json`))) json(k, val);
}
console.log(`[publish-site] wrote snapshot to ${OUT} (${marketOnly ? "market only" : "market + journal"})`);
