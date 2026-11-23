import { describe, expect, it } from "vitest";
import { MAINNET } from "../src/config.js";
import { makeClient } from "../src/common/chain.js";
import { takeSnapshot } from "../src/modules/market-data/snapshot.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";

/** Opt-in: reads real HSK mainnet + exchanges. `LIVE=1 pnpm vitest run test/live.test.ts` */
describe.skipIf(!process.env.LIVE)("live HSK mainnet", () => {
  it("observes all three pools and produces a verdict", { timeout: 60_000 }, async () => {
    const s = await takeSnapshot(makeClient(MAINNET), MAINNET, { withFlow: true });
    expect(s.head).not.toBeNull();
    expect(s.pools).toHaveLength(3);
    for (const p of s.pools) {
      expect(p.error).toBeUndefined();
      expect(p.spot).toBeGreaterThan(0);
      expect(p.quotes.length).toBeGreaterThan(0);
    }
    expect(s.references.find((r) => r.source === "apro")?.error).toBeUndefined();
    const h = evaluateMarket(s, ["WHSK", "WETH", "WBTC"]);
    expect(["VALID", "WARNING", "WAIT", "REJECT"]).toContain(h.status);
  });
});
