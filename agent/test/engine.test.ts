import { describe, expect, it } from "vitest";
import { evaluateMarket, isTradable, worst } from "../src/modules/data-reliability/engine.js";
import { NOW, cex, pool, snap } from "./fixtures.js";

const evalWeth = (s = snap()) => evaluateMarket(s, ["WETH"], { now: NOW }).assets[0]!;
const codes = (h: ReturnType<typeof evalWeth>) => h.findings.map((f) => f.code);

describe("Data Reliability Engine", () => {
  it("VALID with three fresh agreeing sources; computes reference and premium", () => {
    const h = evalWeth();
    expect(h.status).toBe("VALID");
    expect(h.reference).toBe(1711);
    expect(h.premiumBps).toBeCloseTo(((1700 - 1711) / 1711) * 10_000, 6);
    expect(isTradable(h)).toBe(true);
  });

  it("Scenario 1 — a stale external quote is excluded, not trusted", () => {
    const h = evalWeth(
      snap({ references: [cex("gate", 1710), cex("mexc", 1711), cex("hashkey", 1750, { sourceTs: NOW - 10 * 60_000 })] }),
    );
    const hk = h.sources.find((s) => s.source === "hashkey")!;
    expect(hk.accepted).toBe(false);
    expect(hk.reason).toMatch(/stale/);
    expect(h.reference).toBe(1710.5);
    expect(h.status).toBe("VALID");
  });

  it("a wide order book (e.g. HashKey ETH bid 1729 / ask 2130) is excluded", () => {
    const h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", 1711), cex("hashkey", 1929.5, { bid: 1729, ask: 2130 })] }));
    const hk = h.sources.find((s) => s.source === "hashkey")!;
    expect(hk.accepted).toBe(false);
    expect(hk.reason).toMatch(/book too wide/);
  });

  it("a crossed book is excluded", () => {
    const h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", 1711), cex("x", 1712, { bid: 1715, ask: 1709 })] }));
    expect(h.sources.find((s) => s.source === "x")!.reason).toMatch(/crossed/);
  });

  it("an outlier source is excluded relative to the median", () => {
    const h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", 1711), cex("coinbase", 1712), cex("bad", 1800)] }));
    const bad = h.sources.find((s) => s.source === "bad")!;
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toMatch(/outlier/);
    expect(h.reference).toBe(1711);
  });

  it("WARNING when only one reference survives", () => {
    const h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", NaN, { error: "HTTP 500" })] }));
    expect(h.status).toBe("WARNING");
    expect(codes(h)).toContain("SINGLE_REFERENCE");
    expect(isTradable(h)).toBe(true);
  });

  it("WAIT when no reference survives", () => {
    const h = evalWeth(snap({ references: [cex("gate", NaN, { error: "timeout" })] }));
    expect(h.status).toBe("WAIT");
    expect(codes(h)).toContain("NO_RELIABLE_REFERENCE");
    expect(isTradable(h)).toBe(false);
  });

  it("Scenario 9 — RPC unavailable REJECTs every asset", () => {
    const m = evaluateMarket(snap({ head: null, pools: [] }), ["WETH"], { now: NOW });
    expect(m.status).toBe("REJECT");
    expect(m.chain.findings[0]!.code).toBe("RPC_UNAVAILABLE");
    expect(m.assets[0]!.status).toBe("REJECT");
  });

  it("a lagging chain head means WAIT; a stalled one REJECT", () => {
    const lag = snap({ head: { blockNumber: 1, blockTimestamp: NOW / 1000 - 60, rpcLatencyMs: 1 } });
    expect(evaluateMarket(lag, ["WETH"], { now: NOW }).assets[0]!.status).toBe("WAIT");
    const stall = snap({ head: { blockNumber: 1, blockTimestamp: NOW / 1000 - 600, rpcLatencyMs: 1 } });
    expect(evaluateMarket(stall, ["WETH"], { now: NOW }).assets[0]!.status).toBe("REJECT");
  });

  it("spot far from the 5-min TWAP is a spike (REJECT); moderately far is WARNING", () => {
    expect(evalWeth(snap({ pools: [pool({ spot: 1800 })] })).status).toBe("REJECT");
    const h = evalWeth(snap({ pools: [pool({ spot: 1720 })], references: [cex("a", 1720), cex("b", 1721)] }));
    expect(h.status).toBe("WARNING");
    expect(codes(h)).toContain("SPOT_MOVING");
  });

  it("an implausibly large DEX-vs-reference gap is treated as bad data", () => {
    const h = evalWeth(snap({ references: [cex("a", 2000), cex("b", 2001)] }));
    expect(h.status).toBe("REJECT");
    expect(codes(h)).toContain("IMPLAUSIBLE_GAP");
  });

  it("a pool with no liquidity or a failed read is REJECT", () => {
    expect(evalWeth(snap({ pools: [pool({ liquidity: "0" })] })).status).toBe("REJECT");
    expect(evalWeth(snap({ pools: [pool({ error: "boom", spot: NaN })] })).status).toBe("REJECT");
    expect(evalWeth(snap({ pools: [] })).status).toBe("REJECT");
  });

  it("oracle: stale print excluded; disagreeing fresh print is a WARNING; it never sets the reference", () => {
    const stale = cex("apro", 1711, { kind: "oracle", bid: null, ask: null, sourceTs: NOW - 30 * 3600_000 });
    let h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", 1711), stale] }));
    expect(h.sources.find((s) => s.source === "apro")!.reason).toMatch(/stale/);
    expect(h.status).toBe("VALID");

    const off = cex("apro", 1800, { kind: "oracle", bid: null, ask: null });
    h = evalWeth(snap({ references: [cex("gate", 1710), cex("mexc", 1711), off] }));
    expect(codes(h)).toContain("ORACLE_DISAGREES");
    expect(h.reference).toBe(1710.5);
  });

  it("worst() orders statuses", () => {
    expect(worst("VALID", "WARNING")).toBe("WARNING");
    expect(worst("WAIT", "WARNING", "VALID")).toBe("WAIT");
    expect(worst("REJECT", "WAIT")).toBe("REJECT");
    expect(worst()).toBe("VALID");
  });
});
