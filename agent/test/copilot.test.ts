import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET } from "../src/config.js";
import { applyChanges, isTighter, mandateFromJson, mandateToJson } from "../src/copilot/mandate.js";
import { parseMandateChanges, rulesReply, type CopilotCtx } from "../src/copilot/copilot.js";
import { sessionMessage, verifyOwner } from "../src/copilot/owner.js";
import { Store } from "../src/common/store.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { paperVaultState } from "../src/modules/vault/state.js";
import { NOW, cex, snap } from "./fixtures.js";

const base = () => paperVaultState(MAINNET, 10, { maxTradeQuote: 5_000_000n, cooldown: 120, tiersMask: 7, assetsMask: 7, minEdgeBps: 30, dailyLossQuote: 1_000_000n }).mandate;

describe("Mission Control — intent parsing (the four controls)", () => {
  it("position size, frequency, risk, assets, loss limit", () => {
    expect(parseMandateChanges("max trade 3 USDT")).toEqual({ maxTradeUsdt: 3 });
    expect(parseMandateChanges("trade at most once every 10 minutes")).toEqual({ cooldownSec: 600 });
    expect(parseMandateChanges("be more careful")).toEqual({ riskAppetite: "low" });
    expect(parseMandateChanges("go aggressive")).toEqual({ riskAppetite: "high" });
    expect(parseMandateChanges("only trade ETH and BTC")).toEqual({ targetAssets: ["WETH", "WBTC"] });
    expect(parseMandateChanges("stop for the day after losing 0.5")).toEqual({ dailyLossUsdt: 0.5 });
    expect(parseMandateChanges("Low risk, only trade ETH and BTC, at most once every 10 minutes")).toEqual({ riskAppetite: "low", targetAssets: ["WETH", "WBTC"], cooldownSec: 600 });
    expect(parseMandateChanges("how are we doing?")).toBeNull();
  });
});

describe("Mandate diff", () => {
  it("stricter changes are tighter-only (agent may apply)", () => {
    const d = applyChanges(base(), { maxTradeUsdt: 3, cooldownSec: 600, targetAssets: ["WETH"], riskAppetite: "low" });
    expect(d.tighterOnly).toBe(true);
    expect(d.rows.map((r) => r.field).sort()).toEqual(["assetsMask", "cooldown", "maxTradeQuote", "minEdgeBps", "tiersMask"].sort());
    expect(d.proposed.tiersMask).toBe(0b011);
    expect(d.proposed.minEdgeBps).toBe(60);
    expect(d.proposed.assetsMask).toBe(0b010);
  });
  it("any looser field requires the owner", () => {
    expect(applyChanges(base(), { maxTradeUsdt: 10 }).tighterOnly).toBe(false);
    expect(applyChanges(base(), { cooldownSec: 30 }).tighterOnly).toBe(false);
    const m = base();
    m.tiersMask = 0b011;
    expect(applyChanges(m, { riskAppetite: "high" }).tighterOnly).toBe(false);
  });
  it("warns that tiny trades are uneconomic", () => {
    expect(applyChanges(base(), { maxTradeUsdt: 1 }).notes.join()).toMatch(/gas/);
  });
  it("no-op is reported as unchanged", () => {
    expect(applyChanges(base(), { maxTradeUsdt: 5 }).changed).toBe(false);
  });
  it("isTighter mirrors the contract (twapWindow and expiry included)", () => {
    const c = base();
    expect(isTighter(c, { ...c, twapWindow: c.twapWindow + 1 })).toBe(false);
    expect(isTighter(c, { ...c, expiry: c.expiry + 1n })).toBe(false);
    expect(isTighter(c, { ...c, expiry: c.expiry - 1n, maxSlippageBps: 50 })).toBe(true);
  });
  it("JSON round-trip preserves bigints", () => {
    const m = base();
    expect(mandateFromJson(mandateToJson(m) as never)).toEqual(m);
  });
});

describe("Mission Control — rules mode end to end (no LLM key)", () => {
  const ctx = (): CopilotCtx => {
    const store = new Store(":memory:");
    const s = snap({ references: [cex("gate", 1729), cex("mexc", 1730)] });
    store.record(s, evaluateMarket(s, ["WETH"], { now: NOW }));
    store.recordDecision({ at: NOW, kind: "tick", asset: null, outcome: "WAIT", summary: "WAIT — no candidate", payload: {}, hash: "0x01" });
    const guardian = { evaluate: async () => ({ decision: "WAIT", reasons: ["expected-net-value (-0.017 vs 0)"], checks: [{ name: "per-trade-cap", pass: true, severity: "hard" }, { name: "expected-net-value", pass: false, severity: "soft", value: -0.017, limit: 0 }], economics: { expectedNetValueUsdt: -0.017 }, plan: { method: "WAIT" } }), release: async () => undefined };
    return { net: MAINNET, client: {} as never, store, guardian: guardian as never, vault: null };
  };
  it("portfolio by default", async () => {
    const r = await rulesReply(ctx(), "what's open?");
    expect(r.cards[0]!.type).toBe("positions");
    expect(r.reply).toMatch(/USDT/);
  });
  it("why not trading", async () => {
    const r = await rulesReply(ctx(), "why aren't you trading?");
    expect(r.cards[0]!.type).toBe("why");
  });
  it("what-if goes to the Guardian in dry-run", async () => {
    const r = await rulesReply(ctx(), "what if I buy 5 USDT of ETH now?");
    expect(r.cards[0]!.type).toBe("whatif");
    expect(r.reply).toMatch(/would WAIT/);
    expect(r.reply).toMatch(/Nothing was signed/);
  });
  it("mandate change becomes a diff card, never an action", async () => {
    const r = await rulesReply(ctx(), "only trade BTC");
    expect(r.cards[0]!.type).toBe("diff");
    expect((r.cards[0]!.data as { tighterOnly: boolean }).tighterOnly).toBe(true);
  });
  it("market and performance", async () => {
    expect((await rulesReply(ctx(), "show me the market spread")).cards[0]!.type).toBe("market");
    expect((await rulesReply(ctx(), "how are we doing on pnl")).cards[0]!.type).toBe("performance");
  });
});

describe("Owner session", () => {
  const owner = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a11ce");
  const vault = "0x76fB3ae6c48964171a297C88a16513284CfB9eE0" as const;
  const client = (o: string) => ({ readContract: async () => o }) as never;
  it("accepts the owner's signature, rejects others, expired or tampered", async () => {
    const issuedAt = new Date().toISOString();
    const signature = await owner.signMessage({ message: sessionMessage(vault, 177, issuedAt) });
    expect((await verifyOwner(client(owner.address), MAINNET, vault, { address: owner.address, issuedAt, signature })).ok).toBe(true);
    expect((await verifyOwner(client("0x000000000000000000000000000000000000dEaD"), MAINNET, vault, { address: owner.address, issuedAt, signature })).ok).toBe(false);
    expect((await verifyOwner(client(owner.address), MAINNET, vault, { address: owner.address, issuedAt, signature }, Date.now() + 16 * 60_000)).ok).toBe(false);
    const other = new Date(Date.now() - 1000).toISOString();
    expect((await verifyOwner(client(owner.address), MAINNET, vault, { address: owner.address, issuedAt: other, signature })).ok).toBe(false);
    expect((await verifyOwner(client(owner.address), MAINNET, vault, undefined)).ok).toBe(false);
  });
});
