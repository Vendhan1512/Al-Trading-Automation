import type { Mandate } from "../modules/vault/state.js";

/** The four controls the track asks for, plus loss limit — in human units. */
export interface MandateChanges {
  maxTradeUsdt?: number; // position size
  cooldownSec?: number; // trade frequency
  riskAppetite?: "low" | "medium" | "high";
  targetAssets?: ("WHSK" | "WETH" | "WBTC")[];
  dailyLossUsdt?: number;
  dailyVolumeUsdt?: number;
  maxExposureUsdt?: number;
  minEdgeBps?: number;
}

export const ASSET_ORDER = ["WHSK", "WETH", "WBTC"] as const;

/**
 * Risk appetite presets (tiers: bit0 = A arbitrage, bit1 = B spread, bit2 = C AI-directional).
 *  low    — A + B only, double the minimum edge
 *  medium — A + B
 *  high   — A + B + C (AI directional trades allowed)
 */
export function riskPreset(level: "low" | "medium" | "high", current: Mandate): Pick<Mandate, "tiersMask" | "minEdgeBps"> {
  if (level === "low") return { tiersMask: 0b011, minEdgeBps: Math.max(current.minEdgeBps, 60) };
  if (level === "medium") return { tiersMask: 0b011, minEdgeBps: current.minEdgeBps };
  return { tiersMask: 0b111, minEdgeBps: current.minEdgeBps };
}

export interface DiffRow {
  field: string;
  label: string;
  from: string;
  to: string;
  direction: "tighter" | "looser" | "same";
}

export interface MandateDiff {
  current: Mandate;
  proposed: Mandate;
  rows: DiffRow[];
  tighterOnly: boolean; // true => the agent may apply it via tighten(); false => owner must sign setMandate
  changed: boolean;
  notes: string[];
}

const q = (x: number, d: number) => BigInt(Math.round(x * 10 ** d));
const f = (x: bigint, d: number) => (Number(x) / 10 ** d).toString();
const mask = (m: number, names: readonly string[]) => names.filter((_, i) => m & (1 << i)).join("+") || "none";

export function applyChanges(current: Mandate, ch: MandateChanges, quoteDecimals = 6, assetCount = 3): MandateDiff {
  const p: Mandate = { ...current };
  const notes: string[] = [];
  if (ch.maxTradeUsdt !== undefined) p.maxTradeQuote = q(ch.maxTradeUsdt, quoteDecimals);
  if (ch.dailyLossUsdt !== undefined) p.dailyLossQuote = q(ch.dailyLossUsdt, quoteDecimals);
  if (ch.dailyVolumeUsdt !== undefined) p.dailyVolumeQuote = q(ch.dailyVolumeUsdt, quoteDecimals);
  if (ch.maxExposureUsdt !== undefined) p.maxExposureQuote = q(ch.maxExposureUsdt, quoteDecimals);
  if (ch.cooldownSec !== undefined) p.cooldown = Math.max(0, Math.round(ch.cooldownSec));
  if (ch.minEdgeBps !== undefined) p.minEdgeBps = Math.max(0, Math.round(ch.minEdgeBps));
  if (ch.riskAppetite) Object.assign(p, riskPreset(ch.riskAppetite, current));
  if (ch.targetAssets) {
    p.assetsMask = ch.targetAssets.reduce((m, a) => m | (1 << ASSET_ORDER.indexOf(a)), 0) & ((1 << assetCount) - 1);
    if (p.assetsMask === 0) notes.push("no target assets selected — the agent will not open new positions");
  }
  if (p.maxTradeQuote > 0n && Number(p.maxTradeQuote) / 10 ** quoteDecimals < 3)
    notes.push("below ~3 USDT per trade, gas (~$0.024 per round trip at 500 gwei) makes most trades unprofitable — the Guardian will mostly WAIT");
  if (ch.riskAppetite === "low") notes.push("low risk: spread trades only, and only with at least 60 bps of edge");

  const rows: DiffRow[] = [];
  const add = (field: string, label: string, from: string, to: string, tighter: boolean, looser: boolean) =>
    rows.push({ field, label, from, to, direction: tighter ? "tighter" : looser ? "looser" : "same" });
  const lt = (a: bigint | number, b: bigint | number) => a < b;
  add("maxTradeQuote", "Max per trade (USDT)", f(current.maxTradeQuote, quoteDecimals), f(p.maxTradeQuote, quoteDecimals), lt(p.maxTradeQuote, current.maxTradeQuote), lt(current.maxTradeQuote, p.maxTradeQuote));
  add("dailyVolumeQuote", "Daily volume (USDT)", f(current.dailyVolumeQuote, quoteDecimals), f(p.dailyVolumeQuote, quoteDecimals), lt(p.dailyVolumeQuote, current.dailyVolumeQuote), lt(current.dailyVolumeQuote, p.dailyVolumeQuote));
  add("dailyLossQuote", "Daily loss stop (USDT)", f(current.dailyLossQuote, quoteDecimals), f(p.dailyLossQuote, quoteDecimals), lt(p.dailyLossQuote, current.dailyLossQuote), lt(current.dailyLossQuote, p.dailyLossQuote));
  add("maxExposureQuote", "Max exposure per asset (USDT)", f(current.maxExposureQuote, quoteDecimals), f(p.maxExposureQuote, quoteDecimals), lt(p.maxExposureQuote, current.maxExposureQuote), lt(current.maxExposureQuote, p.maxExposureQuote));
  add("cooldown", "Min time between entries (s)", String(current.cooldown), String(p.cooldown), p.cooldown > current.cooldown, p.cooldown < current.cooldown);
  add("minEdgeBps", "Min edge (bps)", String(current.minEdgeBps), String(p.minEdgeBps), p.minEdgeBps > current.minEdgeBps, p.minEdgeBps < current.minEdgeBps);
  const tierNames = ["A arb", "B spread", "C AI-directional"];
  add("tiersMask", "Strategy tiers", mask(current.tiersMask, tierNames), mask(p.tiersMask, tierNames), (p.tiersMask & ~current.tiersMask) === 0 && p.tiersMask !== current.tiersMask, (p.tiersMask & ~current.tiersMask) !== 0);
  add("assetsMask", "Target assets", mask(current.assetsMask, ASSET_ORDER), mask(p.assetsMask, ASSET_ORDER), (p.assetsMask & ~current.assetsMask) === 0 && p.assetsMask !== current.assetsMask, (p.assetsMask & ~current.assetsMask) !== 0);

  const changedRows = rows.filter((r) => r.direction !== "same");
  return { current, proposed: p, rows: changedRows, tighterOnly: isTighter(current, p), changed: changedRows.length > 0, notes };
}

/** Exact mirror of CountersignVault.tighten()'s acceptance rule. */
export function isTighter(c: Mandate, m: Mandate): boolean {
  return !(
    m.maxTradeQuote > c.maxTradeQuote ||
    m.dailyVolumeQuote > c.dailyVolumeQuote ||
    m.dailyLossQuote > c.dailyLossQuote ||
    m.maxExposureQuote > c.maxExposureQuote ||
    m.minArbProfitQuote < c.minArbProfitQuote ||
    m.cooldown < c.cooldown ||
    m.twapWindow !== c.twapWindow ||
    m.maxSlippageBps > c.maxSlippageBps ||
    m.minEdgeBps < c.minEdgeBps ||
    (m.tiersMask & ~c.tiersMask) !== 0 ||
    (m.assetsMask & ~c.assetsMask) !== 0 ||
    m.expiry > c.expiry
  );
}

/** Mandate as JSON-safe strings (bigints) for the API / browser. */
export const mandateToJson = (m: Mandate) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
export const mandateFromJson = (o: Record<string, string | number>): Mandate => ({
  maxTradeQuote: BigInt(o.maxTradeQuote!),
  dailyVolumeQuote: BigInt(o.dailyVolumeQuote!),
  dailyLossQuote: BigInt(o.dailyLossQuote!),
  maxExposureQuote: BigInt(o.maxExposureQuote!),
  minArbProfitQuote: BigInt(o.minArbProfitQuote!),
  cooldown: Number(o.cooldown),
  twapWindow: Number(o.twapWindow),
  maxSlippageBps: Number(o.maxSlippageBps),
  minEdgeBps: Number(o.minEdgeBps),
  tiersMask: Number(o.tiersMask),
  assetsMask: Number(o.assetsMask),
  expiry: BigInt(o.expiry!),
});
