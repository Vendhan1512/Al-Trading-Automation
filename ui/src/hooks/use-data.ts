import * as React from "react";
import { endpoints, isStatic } from "@/lib/api";
import type { Arbitrage, Config, Decision, Health, Portfolio, Prices } from "@/lib/types";

export interface Data {
  config: Config | null;
  portfolio: Portfolio | null;
  prices: Prices | null;
  health: Health | null;
  decisions: Decision[];
  arbitrage: Arbitrage | null;
  staticMode: boolean;
  loadedAt: number;
}

const settle = <T,>(p: Promise<T>) => p.catch(() => null);

/** Polls the agent (or the published snapshot) every `everyMs` while the tab is visible. */
export function useData(everyMs = 15_000): Data {
  const [d, setD] = React.useState<Data>({ config: null, portfolio: null, prices: null, health: null, decisions: [], arbitrage: null, staticMode: false, loadedAt: 0 });
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      const config = await settle(endpoints.config());
      const [portfolio, prices, health, dec, arbitrage] = await Promise.all([
        settle(endpoints.portfolio()), settle(endpoints.prices()), settle(endpoints.health()), settle(endpoints.decisions(120)), settle(endpoints.arbitrage()),
      ]);
      if (!alive) return;
      setD({ config, portfolio, prices, health, decisions: dec?.decisions ?? [], arbitrage, staticMode: isStatic(), loadedAt: Date.now() });
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, everyMs);
    return () => { alive = false; clearInterval(t); };
  }, [everyMs]);
  return d;
}
