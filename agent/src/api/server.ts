import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAINNET } from "../config.js";
import { Store } from "../common/store.js";
import { startMarketMonitor } from "../workers/market-monitor.js";
import type { Address, PublicClient } from "viem";
import type { NetworkConfig } from "../config.js";
import { paperVaultState, readVaultState, usdt } from "../modules/vault/state.js";
import { evaluatePositions } from "../modules/positions/positions.js";
import { computeMetrics } from "../modules/strategy-health/health.js";
import { scanRadar, type RadarReport } from "../modules/arbitrage/radar.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chat, proposeMandateChange, whatIf, type CopilotCtx } from "../copilot/copilot.js";
import { applyMandate, sessionMessage, verifyOwner } from "../copilot/owner.js";
import { enqueueOwnerRequest, listOwnerRequests } from "../modules/owner/requests.js";
import { buildRecord } from "../modules/evidence/record.js";
import type { GuardianClient } from "../modules/execution/guardian-client.js";
import type { ChainOps } from "../modules/transactions/tx-manager.js";

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
  chain?: { net: NetworkConfig; client: PublicClient; vault: Address | null; guardian?: GuardianClient; ops?: ChainOps | null },
) {
const copilotCtx: CopilotCtx | null = chain?.guardian ? { net: chain.net, client: chain.client, store, guardian: chain.guardian, vault: chain.vault } : null;
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
      stopLossBps: m.stopLossBps ?? 0,
      takeProfitBps: m.takeProfitBps ?? 0,
      maxDrawdownBps: m.maxDrawdownBps ?? 0,
    },
    committee: { guardians: v.guardians, threshold: v.threshold },
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

let radarCache: { at: number; report: RadarReport } | null = null;
routes["/api/arbitrage"] = async (_q, res) => {
  if (!chain) return send(res, 503, { error: "no chain context" });
  if (!radarCache || Date.now() - radarCache.at > 60_000) {
    const h = store.latest()?.health;
    const ref = (a: string, fallback: number) => h?.assets.find((x) => x.asset === a)?.reference ?? fallback;
    radarCache = { at: Date.now(), report: await scanRadar(chain.client, chain.net, ref("WHSK", 0.08), ref("WETH", 1700)) };
  }
  send(res, 200, radarCache.report);
};
routes["/api/config"] = (_q, res) =>
  send(res, 200, {
    chainId: chain?.net.chainId ?? 177,
    explorer: chain?.net.explorer ?? "https://hsk.blockscout.com",
    vault: chain?.vault ?? null,
    v2Vault: chain?.vault ?? null, // this agent only drives v2 (committee) vaults
    agent: process.env.AGENT ?? null,
    guardian: process.env.GUARDIAN ?? null,
    riskOfficer: process.env.RISK_OFFICER ?? null,
    owner: process.env.OWNER ?? null,
    contracts: { vaultImplementation: "0x0728B021D518a916edC1dc7689d6fBD23d601098", vaultFactory: chain?.net.vaultFactory ?? null, router: chain?.net.router ?? null },
    mode: process.env.AGENT_MODE ?? "shadow",
    copilot: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "llm" : "rules",
  });
routes["/api/owner/message"] = (_q, res, url) => {
  if (!chain?.vault) return send(res, 400, { error: "no vault configured" });
  const issuedAt = url.searchParams.get("issuedAt") ?? new Date().toISOString();
  send(res, 200, { issuedAt, message: sessionMessage(chain.vault, chain.net.chainId, issuedAt) });
};

routes["/api/record"] = (_q, res) => send(res, 200, buildRecord(store));
routes["/api/owner/requests"] = (_q, res) => send(res, 200, { requests: listOwnerRequests() });

// ---------------- POST routes (copilot / what-if / mandate). Rate-limited; never move funds.
const post: Record<string, (body: any) => Promise<unknown>> = {
  "/api/copilot": async (b) => {
    if (!copilotCtx) throw new Error("copilot unavailable");
    const msgs = (Array.isArray(b?.messages) ? b.messages : [])
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2_000) }));
    return chat(copilotCtx, msgs);
  },
  "/api/whatif": async (b) => {
    if (!copilotCtx) throw new Error("copilot unavailable");
    return whatIf(copilotCtx, String(b.asset).toUpperCase() as never, b.side === "SELL" ? "SELL" : "BUY", Number(b.amountUsdt));
  },
  "/api/mandate/propose": async (b) => {
    if (!copilotCtx) throw new Error("copilot unavailable");
    return proposeMandateChange(copilotCtx, b?.changes ?? {});
  },
  // Owner asks the agent to convert part of a position to USDT. Queued for the next tick, where it
  // becomes an EXIT proposal that BOTH committee members must sign; this route never moves funds.
  "/api/owner/rebalance": async (b) => {
    if (!chain?.vault) throw new Error("no vault configured");
    const asset = String(b?.asset ?? "").toUpperCase();
    if (!["WHSK", "WETH", "WBTC"].includes(asset)) throw new Error("asset must be WHSK, WETH or WBTC");
    const percent = Number(b?.percent);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) throw new Error("percent must be between 1 and 100");
    const who = await verifyOwner(chain.client, chain.net, chain.vault, b?.auth);
    if (!who.ok) return { status: "REFUSED", reason: who.reason };
    const v = await readVaultState(chain.client, chain.net, chain.vault);
    const pos = v.positions.find((p) => p.asset === asset);
    if (!pos || pos.qty === 0n) return { status: "REFUSED", reason: `the vault holds no tracked ${asset}` };
    const req = enqueueOwnerRequest({ asset: asset as never, percent, requestedBy: b.auth.address });
    return { status: "QUEUED", request: req, note: "The agent picks this up on its next tick (about 30 s). The Guardian and the Risk Officer must both sign before the vault executes it." };
  },
  "/api/mandate/apply": async (b) => {
    if (!chain?.vault) throw new Error("no vault configured");
    return applyMandate(chain.client, chain.net, chain.vault, b?.proposed ?? {}, b?.auth, chain.ops ?? null);
  },
};
const hits = new Map<string, number[]>();
const limited = (ip: string) => {
  const now = Date.now();
  const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  h.push(now);
  hits.set(ip, h);
  return h.length > 30;
};

// The React dashboard (ui/dist) when built, else the dependency-free fallback in web/.
const WEB_ROOT = resolve(process.env.WEB_ROOT ?? (existsSync(resolve("../ui/dist/index.html")) ? "../ui/dist" : "../web"));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
const serveStatic = (res: ServerResponse, pathname: string) => {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(file));
  return true;
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST" });
    return res.end();
  }
  if (req.method === "POST") {
    const p = post[url.pathname];
    if (!p) return send(res, 404, { error: "not found" });
    if (limited(req.socket.remoteAddress ?? "?")) return send(res, 429, { error: "slow down" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 32_000) req.destroy();
    });
    req.on("end", () => {
      Promise.resolve()
        .then(() => p(body ? JSON.parse(body) : {}))
        .then((r) => send(res, 200, JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))))
        .catch((e) => send(res, 400, { error: (e as Error).message.split("\n")[0] }));
    });
    return;
  }
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  const h = routes[url.pathname];
  if (!h) {
    if (!url.pathname.startsWith("/api/") && serveStatic(res, url.pathname)) return;
    return send(res, 404, { error: "not found", routes: Object.keys(routes) });
  }
  Promise.resolve()
    .then(() => h(req, res, url))
    .catch((e) => send(res, 500, { error: (e as Error).message.split("\n")[0] }));
}).listen(port, () => console.log(`[api] dashboard http://localhost:${port}/  ·  api http://localhost:${port}/api/market/health`));
}

// `pnpm api` - market monitor + API only (no trading pipeline)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("api/server.ts")) {
  const store = new Store();
  startApi(store);
  startMarketMonitor(store, MAINNET, { verbose: process.env.QUIET !== "1" });
}
