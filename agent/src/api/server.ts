import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAINNET } from "../config.js";
import { Store } from "../common/store.js";
import { startMarketMonitor } from "../workers/market-monitor.js";
import type { Address, PublicClient } from "viem";
import type { NetworkConfig } from "../config.js";
import { paperVaultState, readVaultState, usdt } from "../modules/vault/state.js";
import { evaluatePositions } from "../modules/positions/positions.js";
import { computeMetrics } from "../modules/strategy-health/health.js";

/**
 * Keeper process: runs the market monitor and serves read-only market APIs.
 *   GET /api/market/health     latest Data Reliability verdict (+ staleness)
 *   GET /api/market/prices     compact DEX vs reference prices per asset
 *   GET /api/market/liquidity  impact curve per asset
 *   GET /api/market/snapshot   latest raw snapshot
 *   GET /api/market/history?asset=WBTC&limit=360
 * Public and read-only: nothing here can move funds.
 */
const STALE_AFTER_MS = 3 * Number(process.env.MONITOR_INTERVAL_SEC ?? 30) * 1000;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
}

export function startApi(
  store: Store,
  port = Number(process.env.PORT ?? 8787),
  chain?: { net: NetworkConfig; client: PublicClient; vault: Address | null },
) {
const portfolio = async () => {
  if (!chain) return null;
  const v = chain.vault ? await readVaultState(chain.client, chain.net, chain.vault) : paperVaultState(chain.net);
  const l = store.latest();
  const positions = l ? evaluatePositions(chain.net, v, l.health, store.predictions(), Math.floor(Date.now() / 1000)) : [];
  const posValue = positions.reduce((a, p) => a + (Number.isFinite(p.exitValueUsdt) ? p.exitValueUsdt : 0), 0);
  const usdtBal = usdt(v.quoteBalance, v.quoteDecimals);
  const m = v.mandate;
  return {
    vault: v.address,
    mode: v.mode,
    paused: v.paused,
    usdt: usdtBal,
    totalValueUsdt: usdtBal + posValue,
    today: { volumeUsdt: usdt(v.dayVolume, v.quoteDecimals), realizedPnlUsdt: usdt(v.dayPnl, v.quoteDecimals) },
    mandate: {
      maxTradeUsdt: usdt(m.maxTradeQuote),
      dailyVolumeUsdt: usdt(m.dailyVolumeQuote),
      dailyLossUsdt: usdt(m.dailyLossQuote),
      maxExposureUsdt: usdt(m.maxExposureQuote),
      cooldownSec: m.cooldown,
      maxSlippageBps: m.maxSlippageBps,
      minEdgeBps: m.minEdgeBps,
      tiersMask: m.tiersMask,
      assetsMask: m.assetsMask,
      expiry: Number(m.expiry),
    },
    positions: positions.map((p) => ({ ...p, qtyRaw: p.qtyRaw.toString() })),
  };
};
function latestOr503(res: ServerResponse) {
  const l = store.latest();
  if (!l) {
    send(res, 503, { status: "WAIT", reason: "no market snapshot yet" });
    return null;
  }
  return l;
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>> = {
  "/api/portfolio": async (_q, res) => {
    const p = await portfolio();
    send(res, p ? 200 : 503, p ?? { error: "no chain context" });
  },
  "/api/strategies/health": (_q, res) => {
    const hsk = store.latest()?.health.assets.find((a) => a.asset === "WHSK")?.reference ?? 0.08;
    send(res, 200, computeMetrics(store.trades(), store.predictions(), store.txRecent(500), hsk));
  },
  "/api/transactions": (_q, res, url) => {
    const id = url.searchParams.get("tradeId");
    if (id) return send(res, 200, { tx: store.txGet(id), events: store.txEvents(id) });
    send(res, 200, { transactions: store.txRecent(100).map(({ payload: _p, ...t }) => t) });
  },
  "/api/predictions": (_q, res) => send(res, 200, { predictions: store.predictions().map(({ payload: _p, ...x }) => x) }),
  "/api/trades": (_q, res) => send(res, 200, { trades: store.trades() }),
  "/api/market/health": (_q, res) => {
    const l = latestOr503(res);
    if (!l) return;
    const ageMs = Date.now() - l.health.evaluatedAt;
    // If the monitor itself has stopped, the last verdict must not be trusted.
    const status = ageMs > STALE_AFTER_MS ? "WAIT" : l.health.status;
    send(res, 200, { ...l.health, status, verdictAgeMs: ageMs, monitorStale: ageMs > STALE_AFTER_MS, snapshotId: l.id });
  },
  "/api/market/prices": (_q, res) => {
    const l = latestOr503(res);
    if (!l) return;
    send(res, 200, {
      evaluatedAt: l.health.evaluatedAt,
      assets: l.health.assets.map((a) => ({
        asset: a.asset,
        status: a.status,
        dexSpot: a.dexSpot,
        twap5m: a.twapShort,
        twap30m: a.twapLong,
        reference: a.reference,
        premiumBps: a.premiumBps,
        sources: a.sources.map((s) => ({ source: s.source, mid: s.mid, accepted: s.accepted, reason: s.reason })),
      })),
    });
  },
  "/api/market/liquidity": (_q, res) => {
    const l = latestOr503(res);
    if (!l) return;
    send(res, 200, {
      evaluatedAt: l.health.evaluatedAt,
      pools: l.snapshot.pools.map((p) => ({ asset: p.asset, pool: p.pool, fee: p.fee, liquidity: p.liquidity, quotes: p.quotes })),
    });
  },
  "/api/market/volume": (_q, res) => {
    const l = latestOr503(res);
    if (!l) return;
    send(res, 200, { flows: l.snapshot.flows });
  },
  "/api/market/snapshot": (_q, res) => {
    const l = latestOr503(res);
    if (l) send(res, 200, l.snapshot);
  },
  "/api/market/history": (_q, res, url) => {
    const asset = (url.searchParams.get("asset") ?? "WHSK").toUpperCase();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 360), 5000);
    send(res, 200, { asset, points: store.history(asset, limit) });
  },
  "/api/agent/decisions": (_q, res, url) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    send(res, 200, { decisions: store.recentDecisions(limit) });
  },
  "/api/agent/decision": (_q, res, url) => {
    const d = store.decision(Number(url.searchParams.get("seq")));
    if (!d) return send(res, 404, { error: "unknown seq" });
    send(res, 200, d);
  },
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method !== "GET") return send(res, 405, { error: "read-only API" });
  const h = routes[url.pathname];
  if (!h) return send(res, 404, { error: "not found", routes: Object.keys(routes) });
  Promise.resolve()
    .then(() => h(req, res, url))
    .catch((e) => send(res, 500, { error: (e as Error).message.split("\n")[0] }));
}).listen(port, () => console.log(`[api] http://localhost:${port}/api/market/health`));
}

// `pnpm api` - market monitor + API only (no trading pipeline)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("api/server.ts")) {
  const store = new Store();
  startApi(store);
  startMarketMonitor(store, MAINNET, { verbose: process.env.QUIET !== "1" });
}
