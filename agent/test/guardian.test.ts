import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET } from "../src/config.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { paperVaultState } from "../src/modules/vault/state.js";
import { validate, type ValidationInput } from "../src/guardian/validate.js";
import { domainFor, PERMIT_TYPES, signPermit, toMessage, tradeIdFor } from "../src/guardian/permit.js";
import { loadScopedEnv, parseDotenv } from "../src/common/env.js";
import { makePrediction } from "../src/modules/predictions/prediction.js";
import type { PermitJson, Proposal } from "../src/guardian/types.js";
import { NOW, cex, snap } from "./fixtures.js";

const SPOT = 1700;
const health = (refs = [cex("gate", 1729), cex("mexc", 1730), cex("coinbase", 1731)]) =>
  evaluateMarket(snap({ references: refs }), ["WETH"], { now: NOW }).assets[0]!;

/** 1 USDT -> WETH at spot after 0.3% fee, no impact */
const out = (usdtRaw: bigint, impactBps = 0) => (usdtRaw * 10n ** 12n * 997n * BigInt(10_000 - impactBps)) / (BigInt(SPOT) * 1000n * 10_000n);

function input(over: Partial<ValidationInput> = {}, prop: Partial<Proposal> = {}): ValidationInput {
  const amountIn = BigInt(prop.amountIn ?? "5000000");
  return {
    proposal: { proposalId: "p-1", vault: null, tier: "B", asset: "WETH", side: "BUY", amountIn: amountIn.toString(), prediction: null, predictionHash: null, strategist: null, candidateId: null, ...prop },
    health: health(),
    chainStatus: "VALID",
    vault: bigVault(),
    feePpm: 3000,
    baseDecimals: 18,
    quoteDecimals: 6,
    quotes: [1, 2, 3].map((legs) => ({ legs, amountInPerLeg: amountIn / BigInt(legs), amountOutPerLeg: out(amountIn / BigInt(legs)) })),
    twapFloor: (out(amountIn) * 98n) / 100n,
    gasPriceWei: 500_000_000_000n,
    hskUsd: 0.08,
    nowSec: Math.floor(NOW / 1000),
    reservations: { quote: 0n, volume: 0n, exposure: new Map() },
    ...over,
  };
}
/** 50 USDT vault, 5 USDT per-trade cap (a 1 USDT cap is uneconomic at 500 gwei — see test below) */
function bigVault(usdt = 50) {
  return paperVaultState(MAINNET, usdt, { maxTradeQuote: 5_000_000n, dailyVolumeQuote: 20_000_000n, maxExposureQuote: 10_000_000n, dailyLossQuote: 1_000_000n });
}
const failed = (r: ReturnType<typeof validate>) => r.checks.filter((c) => !c.pass).map((c) => c.name);

describe("Execution Guardian — validation", () => {
  it("APPROVEs a cheap-pool tier-B buy with real edge after all costs", () => {
    const r = validate(input());
    expect(failed(r)).toEqual([]);
    expect(r.decision).toBe("APPROVE");
    expect(r.economics.edgeBps!).toBeGreaterThan(30);
    expect(r.expectedNetValueUsdt).toBeGreaterThan(0);
    expect(r.plan.method).toBe("IMMEDIATE");
  });
  it("Scenario 5 — over the per-trade cap is REJECTed", () => {
    const r = validate(input({}, { amountIn: "6000000" }));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toContain("per-trade-cap");
  });
  it("Scenario 2 — low liquidity / high impact is REJECTed", () => {
    const i = input();
    i.quotes = i.quotes.map((q) => ({ ...q, amountOutPerLeg: out(q.amountInPerLeg, 200) }));
    i.twapFloor = 0n;
    const r = validate(i);
    expect(failed(r)).toContain("price-impact");
    expect(r.decision).toBe("REJECT");
  });
  it("a quote below the vault's TWAP floor is REJECTed", () => {
    const r = validate(input({ twapFloor: out(5_000_000n) * 2n }));
    expect(failed(r)).toContain("twap-floor");
  });
  it("no edge vs the reference => WAIT (edge-or-revert would fail)", () => {
    const r = validate(input({ health: health([cex("gate", 1704), cex("mexc", 1705)]) }));
    expect(r.decision).toBe("WAIT");
    expect(failed(r)).toContain("edge-or-revert");
  });
  it("finding: a 1 USDT trade cannot pay ~$0.024 round-trip gas at 500 gwei => WAIT", () => {
    const r = validate(input({}, { amountIn: "1000000" }));
    expect(r.economics.gasUsdt).toBeCloseTo(0.012, 3);
    expect(failed(r)).toEqual(["expected-net-value"]);
    expect(r.decision).toBe("WAIT");
  });
  it("costs larger than the edge => WAIT on expected net value", () => {
    const r = validate(input({ gasPriceWei: 10n ** 15n, hskUsd: 1 }));
    expect(failed(r)).toContain("expected-net-value");
    expect(r.decision).toBe("WAIT");
  });
  it("cooldown => WAIT; paused, daily loss, exposure, cash => REJECT", () => {
    const v = bigVault();
    expect(validate(input({ vault: { ...v, lastEntryAt: Math.floor(NOW / 1000) - 5 } })).decision).toBe("WAIT");
    expect(failed(validate(input({ vault: { ...v, paused: true } })))).toContain("not-paused");
    expect(failed(validate(input({ vault: { ...v, dayPnl: -1_000_000n } })))).toContain("daily-loss");
    expect(failed(validate(input({ vault: bigVault(2) })))).toContain("available-cash");
    const exp = bigVault();
    exp.positions.find((p) => p.asset === "WETH")!.cost = 6_000_000n;
    expect(failed(validate(input({ vault: exp })))).toContain("asset-exposure");
  });
  it("in-flight reservations count against volume, exposure and cash", () => {
    const r = validate(input({ reservations: { quote: 48_000_000n, volume: 0n, exposure: new Map() } }));
    expect(failed(r)).toContain("available-cash");
  });
  it("Stage 10 — portfolio concentration is enforced", () => {
    const r = validate(input({ vault: bigVault(6) }));
    expect(failed(r)).toContain("concentration");
  });
  it("tier C requires a sworn prediction", () => {
    const r = validate(input({}, { tier: "C" }));
    expect(failed(r)).toContain("sworn-prediction");
  });
  it("Stage 11 — splits when impact falls with size and gas is cheap", () => {
    const i = input({ gasPriceWei: 1n }, { amountIn: "1000000" });
    i.quotes = [
      { legs: 1, amountInPerLeg: 1_000_000n, amountOutPerLeg: out(1_000_000n, 40) },
      { legs: 2, amountInPerLeg: 500_000n, amountOutPerLeg: out(500_000n, 5) },
      { legs: 3, amountInPerLeg: 333_333n, amountOutPerLeg: out(333_333n, 4) },
    ];
    i.twapFloor = 0n;
    const r = validate(i);
    expect(r.plan.method).toBe("SPLIT");
    expect(r.plan.legs.length).toBeGreaterThan(1);
    expect(r.plan.legs[1]!.notBefore).toBe(i.nowSec + 120); // legs spaced by the vault cooldown
  });
  it("exits are not gated by edge or concentration", () => {
    const v = paperVaultState(MAINNET, 1);
    const weth = v.positions.find((p) => p.asset === "WETH")!;
    weth.qty = 10n ** 15n;
    weth.cost = 1_700_000n;
    const sellOut = (10n ** 15n * BigInt(SPOT) * 997n) / 1000n / 10n ** 12n;
    const r = validate({
      ...input({ vault: v, health: health([cex("gate", 1701), cex("mexc", 1702)]) }, { tier: "EXIT", side: "SELL", amountIn: (10n ** 15n).toString() }),
      quotes: [{ legs: 1, amountInPerLeg: 10n ** 15n, amountOutPerLeg: sellOut }],
      twapFloor: 0n,
    });
    expect(r.decision).toBe("APPROVE");
  });
});

describe("Permits", () => {
  const guardian = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000006a4d");
  const vault = "0xB1C5bAf8E167d10e0d15ba5d6e7Ad814c2A7F715" as const;
  const permit: PermitJson = {
    tradeId: tradeIdFor(vault, "p-1", 0),
    tier: 2,
    pathHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    amountIn: "1000000",
    minOut: "580000000000000",
    refAmountOut: "578000000000000",
    expectedNetValue: "-1234",
    predictionHash: makePrediction({ agentId: "a", strategyId: "s", vault, chainId: 177, asset: "WETH", direction: "BUY", entryRef: 1, target: 2, invalidation: 0.5, probability: 0.5, expiresAt: 1, createdAt: 0, candidateId: "c" }).hash,
    decisionHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    policyHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    deadline: 1_800_000_000,
  };
  it("signature recovers to the Guardian; tradeIds are unique per leg", async () => {
    const sig = await signPermit(guardian, 177, vault, permit);
    const who = await recoverTypedDataAddress({ domain: domainFor(177, vault), types: PERMIT_TYPES, primaryType: "ExecutionPermit", message: toMessage(permit), signature: sig });
    expect(who).toBe(guardian.address);
    expect(tradeIdFor(vault, "p-1", 1)).not.toBe(permit.tradeId);
  });
  it("digest matches the deployed vault's permitDigest (testnet, LIVE=1)", async () => {
    if (!process.env.LIVE) return;
    const { createPublicClient, http } = await import("viem");
    const { countersignVaultAbi } = await import("../src/abi/countersignVault.js");
    const c = createPublicClient({ transport: http("https://testnet.hsk.xyz") });
    const onchain = await c.readContract({ address: vault, abi: countersignVaultAbi, functionName: "permitDigest", args: [toMessage(permit)] });
    expect(onchain).toBe(hashTypedData({ domain: domainFor(133, vault), types: PERMIT_TYPES, primaryType: "ExecutionPermit", message: toMessage(permit) }));
  });
});

describe("Key separation", () => {
  it("guardian refuses to start if the agent key is visible", () => {
    process.env.AGENT_PK = "0xabc";
    expect(() => loadScopedEnv("guardian", "nonexistent.env")).toThrow(/AGENT_PK must not be visible/);
    delete process.env.AGENT_PK;
  });
  it("agent refuses to start if the guardian key is visible", () => {
    process.env.GUARDIAN_PK = "0xabc";
    expect(() => loadScopedEnv("agent", "nonexistent.env")).toThrow(/GUARDIAN_PK must not be visible/);
    delete process.env.GUARDIAN_PK;
  });
  it("each role loads only its own secret from a shared .env", () => {
    const vars = parseDotenv("AGENT_PK=0xaaa\nGUARDIAN_PK=0xbbb\nVAULT=0xccc # comment\n");
    expect(vars).toEqual({ AGENT_PK: "0xaaa", GUARDIAN_PK: "0xbbb", VAULT: "0xccc" });
  });
  it("no agent module imports the Guardian service or server", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    walk("src");
    const offenders = files.filter((f) => !f.replace(/\\/g, "/").includes("src/guardian/") && /guardian\/(service|server)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
