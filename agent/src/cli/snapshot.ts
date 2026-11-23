import { MAINNET } from "../config.js";
import { makeClient } from "../common/chain.js";
import { takeSnapshot } from "../modules/market-data/snapshot.js";
import { evaluateMarket } from "../modules/data-reliability/engine.js";
import { renderHealth } from "../modules/market-data/report.js";

/** One-shot: observe HSK mainnet markets and print the reliability verdict. `pnpm snapshot [--json]` */
const client = makeClient(MAINNET);
const snap = await takeSnapshot(client, MAINNET, { withFlow: true });
const health = evaluateMarket(snap, MAINNET.pools.map((p) => p.asset));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ snapshot: snap, health }, null, 2));
} else {
  console.log(renderHealth(health));
  for (const f of snap.flows)
    console.log(
      `  flow ${f.asset}: ${f.swaps} swaps in last ~6h · buys $${f.buyVolumeUsdt.toFixed(2)} · sells $${f.sellVolumeUsdt.toFixed(2)}`,
    );
  if (snap.errors.length) console.log("errors:", snap.errors);
}
