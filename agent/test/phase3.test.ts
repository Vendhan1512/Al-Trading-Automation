import { describe, expect, it } from "vitest";
import { MAINNET, type NetworkConfig } from "../src/config.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { entryHeadroomUsdt, meanReversionCandidates, scanCycles, spreadCandidates, zScore } from "../src/modules/strategies/candidates.js";
import { filterCandidates } from "../src/modules/strategy-filter/filter.js";
import { decide, enforceBounds, rulesDecide, StrategistOutput } from "../src/modules/ai-strategist/strategist.js";
import { canonicalJson, hashPrediction, makePrediction } from "../src/modules/predictions/prediction.js";
import { paperVaultState } from "../src/modules/vault/state.js";
import { NOW, cex, pool, snap } from "./fixtures.js";

const ASSETS = ["WETH"] as const;
// WETH pool 1700 vs exchanges ~1730 => premium ≈ -173 bps (pool cheap)
const cheapHealth = () =>
  evaluateMarket(snap({ references: [cex("gate", 1729), cex("mexc", 1730), cex("coinbase", 1731)] }), [...ASSETS], { now: NOW });
const fairHealth = () => evaluateMarket(snap({ references: [cex("gate", 1701), cex("mexc", 1702)] }), [...ASSETS], { now: NOW });
const vault = (o: Parameters<typeof paperVaultState>[2] = {}, usdt = 10) => paperVaultState(MAINNET, usdt, o);

describe("Tier B spread candidates", () => {
  it("BUY when the pool is cheaper than fee + impact + edge + buffer", () => {
    const c = spreadCandidates(MAINNET, cheapHealth(), vault(), NOW);
    expect(c).toHaveLength(1);
    expect(c[0]!.side).toBe("BUY");
    expect(c[0]!.tier).toBe("B");
    expect(c[0]!.maxSizeUsdt).toBe(1); // mandate per-trade cap
    expect(c[0]!.target).toBeGreaterThan(c[0]!.entry);
    expect(c[0]!.invalidation).toBeLessThan(c[0]!.entry);
    expect(c[0]!.grossEdgeBps).toBeGreaterThan(100);
  });
  it("nothing inside the band", () => {
    expect(spreadCandidates(MAINNET, fairHealth(), vault(), NOW)).toHaveLength(0);
  });
  it("nothing when tier B is disabled (risk appetite low)", () => {
    expect(spreadCandidates(MAINNET, cheapHealth(), vault({ tiersMask: 1 }), NOW)).toHaveLength(0);
  });
  it("SELL only with tracked inventory when the pool is rich", () => {
    const rich = evaluateMarket(snap({ references: [cex("gate", 1670), cex("mexc", 1671)] }), [...ASSETS], { now: NOW });
    expect(spreadCandidates(MAINNET, rich, vault(), NOW)).toHaveLength(0);
    const v = vault();
    const weth = v.positions.find((p) => p.asset === "WETH")!;
    weth.qty = 10n ** 15n; // 0.001 WETH ≈ 1.7 USDT
    weth.cost = 1_600_000n;
    const s = spreadCandidates(MAINNET, rich, v, NOW);
    expect(s).toHaveLength(1);
    expect(s[0]!.side).toBe("SELL");
  });
  it("headroom = min(cap, daily volume left, exposure left, cash)", () => {
    const v = vault({}, 0.4);
    expect(entryHeadroomUsdt(v, "WETH")).toBe(0.4);
    const v2 = vault();
    v2.dayVolume = 4_700_000n;
    expect(entryHeadroomUsdt(v2, "WETH")).toBeCloseTo(0.3);
    const v3 = vault();
    v3.positions.find((p) => p.asset === "WETH")!.cost = 2_800_000n;
    expect(entryHeadroomUsdt(v3, "WETH")).toBeCloseTo(0.2);
  });
});

describe("Tier C mean reversion and Tier A scanner", () => {
  it("zScore", () => {
    expect(zScore([1, 1, 1])).toBeNull();
    expect(zScore([10, 11, 9, 10, 11, 9, 5])!.z).toBeLessThan(-2);
  });
  it("needs enough history and an oversold pool that is not rich", () => {
    const h = fairHealth();
    const flat = Array.from({ length: 40 }, (_, i) => 1720 + (i % 2 ? 2 : -2));
    expect(meanReversionCandidates(MAINNET, h, vault(), () => flat.slice(0, 10), NOW)).toHaveLength(0);
    const c = meanReversionCandidates(MAINNET, h, vault(), () => [...flat, 1700], NOW);
    expect(c).toHaveLength(1);
    expect(c[0]!.tier).toBe("C");
    expect(c[0]!.maxSizeUsdt).toBe(0.5); // half size for directional trades
  });
  it("HSKSwap today is a star: no distinct-pool cycle", () => {
    const s = scanCycles(MAINNET, NOW);
    expect(s.cycles).toBe(0);
    expect(s.note).toMatch(/dormant/);
  });
  it("finds a cycle when a cross pool exists", () => {
    const [whsk, weth] = [MAINNET.pools[0]!, MAINNET.pools[1]!];
    const tri: NetworkConfig = {
      ...MAINNET,
      pools: [...MAINNET.pools, { ...whsk, asset: "WHSK", address: "0x000000000000000000000000000000000000c0de", quote: weth.base }],
    };
    expect(scanCycles(tri, NOW).cycles).toBeGreaterThan(0);
  });
});

describe("Strategy Filter", () => {
  const cands = () => spreadCandidates(MAINNET, cheapHealth(), vault(), NOW);
  it("passes a clean candidate", () => {
    const [v] = filterCandidates(cands(), cheapHealth(), vault(), NOW);
    expect(v!.outcome).toBe("PASS");
  });
  it("paused vault rejects entries; cooldown waits; expiry rejects", () => {
    expect(filterCandidates(cands(), cheapHealth(), { ...vault(), paused: true }, NOW)[0]!.outcome).toBe("REJECT");
    const cd = { ...vault(), lastEntryAt: Math.floor(NOW / 1000) - 10 };
    const w = filterCandidates(cands(), cheapHealth(), cd, NOW)[0]!;
    expect(w.outcome).toBe("WAIT");
    expect(w.reasons.join()).toMatch(/cooldown/);
    expect(filterCandidates(cands(), cheapHealth(), vault(), NOW + 10 * 60_000)[0]!.reasons.join()).toMatch(/expired/);
  });
  it("daily loss limit rejects entries; in-flight asset waits", () => {
    const v = { ...vault(), dayPnl: -600_000n };
    expect(filterCandidates(cands(), cheapHealth(), v, NOW)[0]!.reasons.join()).toMatch(/daily loss/);
    expect(filterCandidates(cands(), cheapHealth(), vault(), NOW, { inFlightAssets: new Set(["WETH"]) })[0]!.outcome).toBe("WAIT");
  });
  it("unreliable data waits", () => {
    const bad = evaluateMarket(snap({ references: [cex("gate", NaN, { error: "x" })] }), [...ASSETS], { now: NOW });
    const c = cands();
    expect(filterCandidates(c, bad, vault(), NOW)[0]!.outcome).toBe("WAIT");
  });
});

describe("AI Strategist bounds (the model can only shrink or skip)", () => {
  const c = () => spreadCandidates(MAINNET, cheapHealth(), vault(), NOW)[0]!;
  it("clamps size, probability, and replaces bad levels with the rule's", () => {
    const cand = c();
    const d = enforceBounds(
      cand,
      { candidateId: cand.id, action: "TAKE", sizeFraction: 5, probability: 1.4, target: cand.entry * 0.9, invalidation: cand.entry * 2, horizonMinutes: 1, rationale: "x" },
      "llm",
    );
    expect(d.sizeUsdt).toBe(cand.maxSizeUsdt);
    expect(d.probability).toBe(0.99);
    expect(d.target).toBe(cand.target);
    expect(d.invalidation).toBe(cand.invalidation);
    expect(d.horizonSec).toBe(300);
    expect(d.adjustments.length).toBeGreaterThanOrEqual(5);
  });
  it("rules-only: takes tier B, skips tier C", () => {
    const r = rulesDecide([c()]);
    expect(r.decisions[0]!.action).toBe("TAKE");
  });
  it("without credentials decide() degrades to rules", async () => {
    const prev = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const r = await decide([c()], cheapHealth(), vault());
    expect(r.source).toBe("rules");
    expect(r.note).toMatch(/no Anthropic credentials/);
    [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN] = prev;
  });
  it("uses model output, ignores unknown candidates, enforces bounds", async () => {
    const cand = c();
    const fake = {
      beta: {
        messages: {
          parse: async () => ({
            stop_reason: "end_turn",
            model: "claude-opus-5-5",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
            parsed_output: StrategistOutput.parse({
              regime: "dislocated",
              decisions: [
                { candidateId: cand.id, action: "TAKE", sizeFraction: 0.5, probability: 0.6, target: cand.target, invalidation: cand.invalidation, horizonMinutes: 120, rationale: "gap 170bps > costs" },
                { candidateId: "invented", action: "TAKE", sizeFraction: 1, probability: 0.9, target: 1, invalidation: 1, horizonMinutes: 60, rationale: "made up" },
              ],
            }),
          }),
        },
      },
    };
    const r = await decide([cand], cheapHealth(), vault(), { client: fake as never });
    expect(r.source).toBe("llm");
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]!.sizeUsdt).toBe(0.5);
    expect(r.note).toMatch(/invented/);
  });
  it("refusal or thrown error falls back to rules", async () => {
    const refusing = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null }) } } };
    expect((await decide([c()], cheapHealth(), vault(), { client: refusing as never })).note).toMatch(/refused/);
    const throwing = { beta: { messages: { parse: async () => { throw new Error("network down"); } } } };
    expect((await decide([c()], cheapHealth(), vault(), { client: throwing as never })).note).toMatch(/LLM unavailable/);
  });
});

describe("Sworn predictions", () => {
  const base = { agentId: "a", strategyId: "s", vault: null, chainId: 177, asset: "WETH", direction: "BUY" as const, entryRef: 1700, target: 1715, invalidation: 1675, probability: 0.6, expiresAt: 1, createdAt: 0, candidateId: "c" };
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it("hash is deterministic and changes with any field", () => {
    const a = makePrediction(base);
    expect(makePrediction(base).hash).toBe(a.hash);
    expect(hashPrediction(a.prediction)).toBe(a.hash);
    expect(makePrediction({ ...base, probability: 0.61 }).hash).not.toBe(a.hash);
    expect(a.prediction.statement).toMatch(/predicts WETH/);
  });
  it("refuses non-finite numbers", () => {
    expect(() => makePrediction({ ...base, target: NaN })).toThrow();
  });
});
