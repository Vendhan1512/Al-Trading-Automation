import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAINNET } from "../config.js";
import { Store } from "../common/store.js";
import { startMarketMonitor } from "../workers/market-monitor.js";

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

export function startApi(store: Store, port = Number(process.env.PORT ?? 8787)) {
function latestOr503(res: ServerResponse) {
  const l = store.latest();
  if (!l) {
    send(res, 503, { status: "WAIT", reason: "no market snapshot yet" });
    return null;
  }
  return l;
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void> = {
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
  try {
    h(req, res, url);
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}).listen(port, () => console.log(`[api] http://localhost:${port}/api/market/health`));
}

// `pnpm api` - market monitor + API only (no trading pipeline)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("api/server.ts")) {
  const store = new Store();
  startApi(store);
  startMarketMonitor(store, MAINNET, { verbose: process.env.QUIET !== "1" });
}
