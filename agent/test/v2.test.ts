import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../src/config.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { paperVaultState } from "../src/modules/vault/state.js";
import { validate, type ValidationInput } from "../src/guardian/validate.js";
import { RISK_POLICY } from "../src/guardian/risk-officer.js";
import { applyChanges, isTighter, tighterBps } from "../src/copilot/mandate.js";
import { parseMandateChanges } from "../src/copilot/copilot.js";
import { loadScopedEnv } from "../src/common/env.js";
import { NOW, cex, snap } from "./fixtures.js";

const SPOT = 1700;
const out = (usdtRaw: bigint, impactBps = 0) => (usdtRaw * 10n ** 12n * 997n * BigInt(10_000 - impactBps)) / (BigInt(SPOT) * 1000n * 10_000n);
const health = () => evaluateMarket(snap({ references: [cex("gate", 1759), cex("mexc", 1760)] }), ["WETH"], { now: NOW }).assets[0]!;
const vault = () =>
  paperVaultState(MAINNET, 50, { maxTradeQuote: 5_000_000n, dailyVolumeQuote: 20_000_000n, maxExposureQuote: 10_000_000n, dailyLossQuote: 1_000_000n });

function input(over: Partial<ValidationInput> = {}): ValidationInput {
  const amountIn = 5_000_000n;
  return {
    proposal: { proposalId: "p", vault: null, tier: "B", asset: "WETH", side: "BUY", amountIn: amountIn.toString(), prediction: null, predictionHash: null, strategist: null, candidateId: null },
    health: health(),
    chainStatus: "VALID",
    vault: vault(),
    feePpm: 3000,
    baseDecimals: 18,
    quoteDecimals: 6,
    quotes: [{ legs: 1, amountInPerLeg: amountIn, amountOutPerLeg: out(amountIn) }],
    twapFloor: 0n,
    gasPriceWei: 500_000_000_000n,
    hskUsd: 0.08,
    nowSec: Math.floor(NOW / 1000),
    reservations: { quote: 0n, volume: 0n, exposure: new Map() },
    ...over,
  };
}
const failed = (r: ReturnType<typeof validate>) => r.checks.filter((c) => !c.pass).map((c) => c.name);

describe("v2 Guardian mirrors of the vault", () => {
  it("baseline approves", () => {
    expect(validate(input()).decision).toBe("APPROVE");
  });
  it("re-entry lockout after a stop => WAIT", () => {
    const v = vault();
    v.positions.find((p) => p.asset === "WETH")!.reentryBlockedUntil = Math.floor(NOW / 1000) + 600;
    const r = validate(input({ vault: v }));
    expect(failed(r)).toEqual(["reentry-lockout"]);
    expect(r.decision).toBe("WAIT");
  });
  it("drawdown breaker: tripped or NAV below the floor => REJECT", () => {
    const t = { ...vault(), breakerTripped: true, highWaterMark: 50_000_000n, nav: 49_000_000n };
    expect(failed(validate(input({ vault: t })))).toContain("drawdown-breaker");
    const below = { ...vault(), highWaterMark: 60_000_000n, nav: 50_000_000n }; // -16.7% with a 10% breaker
    const r = validate(input({ vault: below }));
    expect(r.decision).toBe("REJECT");
    const ok = { ...vault(), highWaterMark: 52_000_000n, nav: 50_000_000n };
    expect(validate(input({ vault: ok })).decision).toBe("APPROVE");
  });
  it("expected-value floor from the mandate", () => {
    const v = vault();
    v.mandate.minNetValueQuote = 1_000_000n; // demand 1 USDT net on a 5 USDT trade
    expect(failed(validate(input({ vault: v })))).toEqual(["expected-net-value"]);
  });
  it("the Risk Officer's policy is strictly tighter than the Guardian's", () => {
    expect(RISK_POLICY.maxImpactBps).toBeLessThan(50);
    expect(RISK_POLICY.maxConcentrationPct).toBeLessThan(70);
    expect(RISK_POLICY.maxTotalExposurePct).toBeLessThan(90);
    // a trade at 40 bps impact passes the Guardian but not the Risk Officer
    const i = input({ quotes: [{ legs: 1, amountInPerLeg: 5_000_000n, amountOutPerLeg: out(5_000_000n, 40) }], health: evaluateMarket(snap({ references: [cex("gate", 1760), cex("mexc", 1761)] }), ["WETH"], { now: NOW }).assets[0]! });
    expect(failed(validate(i))).not.toContain("price-impact");
    expect(failed(validate({ ...i, policy: RISK_POLICY }))).toContain("price-impact");
  });
});

describe("v2 mandate controls in Mission Control", () => {
  const base = () => paperVaultState(MAINNET, 10, { stopLossBps: 300, takeProfitBps: 0, maxDrawdownBps: 1000 }).mandate;
  it("parses stop-loss / take-profit / drawdown", () => {
    expect(parseMandateChanges("stop loss 2%")).toEqual({ stopLossPct: 2 });
    expect(parseMandateChanges("take profit at 4.5%")).toEqual({ takeProfitPct: 4.5 });
    expect(parseMandateChanges("max drawdown 8%")).toEqual({ maxDrawdownPct: 8 });
  });
  it("a tighter stop is agent-appliable; turning it off needs the owner", () => {
    expect(applyChanges(base(), { stopLossPct: 2 }).tighterOnly).toBe(true);
    expect(applyChanges(base(), { stopLossPct: 0 }).tighterOnly).toBe(false);
    expect(applyChanges(base(), { stopLossPct: 5 }).tighterOnly).toBe(false);
    expect(applyChanges(base(), { takeProfitPct: 5 }).tighterOnly).toBe(true); // switching on is tighter
    expect(applyChanges(base(), { maxDrawdownPct: 5 }).rows.map((r) => r.field)).toEqual(["maxDrawdownBps"]);
  });
  it("tighterBps / isTighter mirror the contract", () => {
    expect(tighterBps(0, 0)).toBe(true);
    expect(tighterBps(0, 300)).toBe(true);
    expect(tighterBps(300, 0)).toBe(false);
    expect(tighterBps(300, 301)).toBe(false);
    expect(tighterBps(300, 200)).toBe(true);
    const m = { ...base(), minNetValueQuote: 5n };
    expect(isTighter(m, { ...m, minNetValueQuote: 6n })).toBe(true); // demanding more expected value is stricter
    expect(isTighter(m, { ...m, minNetValueQuote: 4n })).toBe(false); // demanding less is looser
    expect(isTighter(m, { ...m, stopLossBps: 0 })).toBe(false); // switching the stop off is looser
  });
});

describe("v2 key separation (three roles)", () => {
  it("risk officer refuses to start next to the agent or guardian key", () => {
    process.env.GUARDIAN_PK = "0x1";
    expect(() => loadScopedEnv("risk", "nonexistent.env")).toThrow(/GUARDIAN_PK must not be visible/);
    delete process.env.GUARDIAN_PK;
    process.env.AGENT_PK = "0x1";
    expect(() => loadScopedEnv("risk", "nonexistent.env")).toThrow(/AGENT_PK must not be visible/);
    delete process.env.AGENT_PK;
  });
  it("agent and guardian refuse to start next to the risk officer key", () => {
    process.env.RISK_OFFICER_PK = "0x1";
    expect(() => loadScopedEnv("agent", "nonexistent.env")).toThrow(/RISK_OFFICER_PK/);
    expect(() => loadScopedEnv("guardian", "nonexistent.env")).toThrow(/RISK_OFFICER_PK/);
    delete process.env.RISK_OFFICER_PK;
  });
  it("no agent-side module has a runtime (non-type) import of any committee member", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    walk("src");
    const committee = /from\s+"[^"]*guardian\/(service|server|risk-officer|risk-server)\.js"/;
    const offenders = files
      .filter((f) => !f.replace(/\\/g, "/").includes("src/guardian/"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split(/\r?\n/)
          .filter((l) => committee.test(l) && !/^\s*import\s+type\b/.test(l))
          .map((l) => `${f}: ${l.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
