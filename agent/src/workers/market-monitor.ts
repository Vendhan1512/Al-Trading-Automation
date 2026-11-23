import { MAINNET, type NetworkConfig } from "../config.js";
import { makeClient } from "../common/chain.js";
import { Store } from "../common/store.js";
import { takeSnapshot } from "../modules/market-data/snapshot.js";
import { evaluateMarket, type MarketHealth } from "../modules/data-reliability/engine.js";
import { renderHealth } from "../modules/market-data/report.js";
import type { MarketSnapshot } from "../modules/market-data/types.js";

export interface MonitorOptions {
  intervalSec: number;
  flowEvery: number; // read swap flow every N ticks (getLogs is the expensive call)
  verbose: boolean;
  onTick?: (snap: MarketSnapshot, health: MarketHealth, id: number) => void;
}

/** Continuous Market Monitoring (Stage 4) + Data Reliability (Stage 5). Never throws out of the loop. */
export function startMarketMonitor(store: Store, net: NetworkConfig = MAINNET, opts: Partial<MonitorOptions> = {}) {
  const o: MonitorOptions = {
    intervalSec: Number(process.env.MONITOR_INTERVAL_SEC ?? 30),
    flowEvery: 10,
    verbose: true,
    ...opts,
  };
  const client = makeClient(net);
  let tick = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    const started = Date.now();
    try {
      const snap = await takeSnapshot(client, net, { withFlow: tick % o.flowEvery === 0 });
      const health = evaluateMarket(snap, net.pools.map((p) => p.asset));
      const id = store.record(snap, health);
      o.onTick?.(snap, health, id);
      if (o.verbose) console.log(`#${id} (${Date.now() - started} ms)\n${renderHealth(health)}`);
    } catch (e) {
      console.error(`[monitor] tick failed: ${(e as Error).message}`);
    } finally {
      tick++;
      // schedule from the END of the tick so slow ticks never overlap
      if (!stopped) timer = setTimeout(run, o.intervalSec * 1000);
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// `pnpm monitor` — standalone monitor process
if (process.argv[1]?.replace(/\\/g, "/").endsWith("workers/market-monitor.ts")) {
  const store = new Store();
  console.log(`[monitor] HSK mainnet · every ${process.env.MONITOR_INTERVAL_SEC ?? 30}s · db ${process.env.COUNTERSIGN_DB ?? "./data/countersign.db"}`);
  const m = startMarketMonitor(store);
  process.on("SIGINT", () => {
    m.stop();
    process.exit(0);
  });
}
