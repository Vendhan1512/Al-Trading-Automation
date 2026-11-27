// Live mode: the running agent serves /api/*. Static mode (GitHub Pages): the same data comes from
// JSON snapshots in ./data/, written by `pnpm publish-site` and a scheduled, keyless Action.
import type { Arbitrage, Config, Decision, DecisionDetail, Health, History, Portfolio, Prices, Predictions, Trades, Transactions } from "./types";

let STATIC: boolean | null = null;
export const isStatic = () => STATIC === true;

function snapshotPath(p: string): string | null {
  const u = new URL(p, "http://x");
  const q = u.searchParams;
  const m: Record<string, string> = {
    "/api/config": "config", "/api/portfolio": "portfolio", "/api/market/prices": "prices", "/api/strategies/health": "health",
    "/api/agent/decisions": "decisions", "/api/arbitrage": "arbitrage", "/api/transactions": "transactions", "/api/trades": "trades", "/api/predictions": "predictions", "/api/record": "record",
  };
  if (m[u.pathname]) return `data/${m[u.pathname]}.json`;
  if (u.pathname === "/api/market/history") return `data/history-${q.get("asset")}.json`;
  if (u.pathname === "/api/agent/decision") return `data/decision-${q.get("seq")}.json`;
  return null;
}

export async function api<T>(p: string): Promise<T> {
  if (STATIC !== true) {
    try {
      const r = await fetch(p.slice(1), { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
        if (p === "/api/config") STATIC = false;
        return (await r.json()) as T;
      }
      if (p === "/api/config") STATIC = true;
      else if (r.status !== 404) throw new Error(`${p}: HTTP ${r.status}`);
    } catch (e) {
      if (p !== "/api/config") throw e;
      STATIC = true;
    }
  }
  const sp = snapshotPath(p);
  if (!sp) throw new Error(`${p}: not available in the public snapshot`);
  const r = await fetch(sp, { cache: "no-store" });
  if (!r.ok) throw new Error(`${sp}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function post<T>(p: string, body: unknown): Promise<T> {
  if (STATIC) throw new Error("Mission Control talks to the running agent. This public page is a published snapshot: run the agent locally (see README) to chat, ask what-if questions and change the mandate.");
  const r = await fetch(p.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export const endpoints = {
  config: () => api<Config>("/api/config"),
  portfolio: () => api<Portfolio>("/api/portfolio"),
  prices: () => api<Prices>("/api/market/prices"),
  health: () => api<Health>("/api/strategies/health"),
  decisions: (limit = 120) => api<{ decisions: Decision[] }>(`/api/agent/decisions?limit=${limit}`),
  decision: (seq: number) => api<DecisionDetail>(`/api/agent/decision?seq=${seq}`),
  history: (asset: string) => api<History>(`/api/market/history?asset=${asset}&limit=240`),
  arbitrage: () => api<Arbitrage>("/api/arbitrage"),
  transactions: () => api<Transactions>("/api/transactions"),
  trades: () => api<Trades>("/api/trades"),
  predictions: () => api<Predictions>("/api/predictions"),
  record: <T,>() => api<T>("/api/record"),
};
