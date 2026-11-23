import { describe, expect, it } from "vitest";
import { bps, fromUnits, meanTick, median, orientPrice, priceFromSqrtX96, priceFromTick, toUnits } from "../src/common/math.js";
import { SOURCES, toQuote } from "../src/modules/market-data/references.js";
import { Store } from "../src/common/store.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { NOW, snap } from "./fixtures.js";

describe("price math", () => {
  it("matches the live WHSK/USDT pool (sqrtPriceX96 22518832747279392983080 -> ~0.0808 USDT)", () => {
    const p = priceFromSqrtX96(22518832747279392983080n, 18, 6);
    expect(p).toBeGreaterThan(0.0805);
    expect(p).toBeLessThan(0.081);
  });
  it("tick and sqrt price agree (tick -301485)", () => {
    expect(priceFromTick(-301485, 18, 6)).toBeCloseTo(priceFromSqrtX96(22518832747279392983080n, 18, 6), 4);
  });
  it("meanTick rounds toward -infinity like OracleLibrary", () => {
    expect(meanTick(-7n, 0n, 2)).toBe(-4);
    expect(meanTick(7n, 0n, 2)).toBe(3);
    expect(meanTick(-6n, 0n, 2)).toBe(-3);
  });
  it("orientPrice, bps, median, units", () => {
    expect(orientPrice(2, false)).toBe(0.5);
    expect(bps(101, 100)).toBeCloseTo(100);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(toUnits(1.5, 6)).toBe(1_500_000n);
    expect(toUnits(0.000001, 6)).toBe(1n);
    expect(toUnits(2, 18)).toBe(2_000_000_000_000_000_000n);
    expect(fromUnits(1_500_000n, 6)).toBe(1.5);
  });
});

describe("exchange parsers (recorded real responses)", () => {
  const src = (n: string) => SOURCES.find((s) => s.name === n)!;
  it("hashkey", () => {
    const p = src("hashkey").parse([{ s: "HSKUSDT", b: "0.0806", bq: "136.51", a: "0.0807", aq: "3846.59", t: 1795418171924 }]);
    expect(p).toEqual({ bid: 0.0806, ask: 0.0807, sourceTs: 1795418171924 });
  });
  it("gate", () => {
    const p = src("gate").parse([{ currency_pair: "HSK_USDT", last: "0.0807", lowest_ask: "0.08089", highest_bid: "0.0807" }]);
    expect(p.bid).toBe(0.0807);
    expect(p.ask).toBe(0.08089);
  });
  it("mexc", () => {
    expect(src("mexc").parse({ symbol: "HSKUSDT", bidPrice: "0.08002", askPrice: "0.08060" }).ask).toBe(0.0806);
  });
  it("coinbase", () => {
    const p = src("coinbase").parse({ ask: "1724.76", bid: "1724.62", time: "2026-11-23T07:16:36.152443494Z" });
    expect(p.sourceTs).toBe(Date.parse("2026-11-23T07:16:36.152Z"));
  });
  it("malformed payloads throw (and are recorded as source errors upstream)", () => {
    expect(() => src("gate").parse([])).toThrow();
    expect(() => src("mexc").parse({ price: 1 })).toThrow();
    expect(() => src("hashkey").parse({ error: "x" })).toThrow();
  });
  it("toQuote flags an invalid book", () => {
    expect(toQuote("x", "WHSK", { bid: 0, ask: 1, sourceTs: null }, 1, 1).error).toBe("invalid book");
    expect(toQuote("x", "WHSK", { bid: 1, ask: 3, sourceTs: null }, 1, 1).mid).toBe(2);
  });
});

describe("store", () => {
  it("records and reads back; tables are append-only", () => {
    const s = new Store(":memory:");
    const sn = snap();
    const id = s.record(sn, evaluateMarket(sn, ["WETH"], { now: NOW }));
    expect(s.latest()!.id).toBe(id);
    expect(s.latest()!.health.assets[0]!.reference).toBe(1711);
    expect(s.history("WETH")).toHaveLength(1);
    expect(s.count()).toBe(1);
    expect(() => s.db.exec("UPDATE market_snapshots SET chain_id = 1")).toThrow(/append-only/);
    expect(() => s.db.exec("UPDATE market_health SET status = 'VALID'")).toThrow(/append-only/);
  });
});
