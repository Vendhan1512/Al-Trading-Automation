import type { AssetHealth } from "../modules/data-reliability/engine.js";
import { isTradable } from "../modules/data-reliability/engine.js";
import { tierBit, usdt, type VaultState } from "../modules/vault/state.js";
import type { Check, Decision, ExecutionPlan, Proposal } from "./types.js";

export interface GuardianPolicy {
  execSlippageBps: number; // minOut = quote * (1 - this)
  maxImpactBps: number; // per-trade price impact ceiling (fee excluded)
  maxConcentrationPct: number; // one asset's share of vault value after the trade
  maxTotalExposurePct: number; // all non-quote assets' share of vault value after the trade
  gasUnits: number; // gas estimate per vault swap (measured 205k–284k on fork)
  minNetValueUsdt: number; // entries must clear this after all costs
  permitTtlSec: number;
}

export const DEFAULT_GUARDIAN_POLICY: GuardianPolicy = {
  execSlippageBps: 25,
  maxImpactBps: 50,
  maxConcentrationPct: 70,
  maxTotalExposurePct: 90,
  gasUnits: 300_000,
  minNetValueUsdt: 0,
  permitTtlSec: 120,
};

export interface Reservations {
  quote: bigint; // USDT committed to in-flight permits
  volume: bigint;
  exposure: Map<string, bigint>; // asset -> cost basis reserved
}

export interface QuoteSample {
  legs: number;
  amountInPerLeg: bigint;
  amountOutPerLeg: bigint;
}

export interface ValidationInput {
  proposal: Proposal;
  health: AssetHealth;
  chainStatus: "VALID" | "WARNING" | "WAIT" | "REJECT";
  vault: VaultState;
  feePpm: number;
  baseDecimals: number;
  quoteDecimals: number;
  quotes: QuoteSample[]; // legs = 1 must be present
  twapFloor: bigint; // vault.twapFloor(...) for the full amount
  gasPriceWei: bigint;
  hskUsd: number;
  nowSec: number;
  reservations: Reservations;
  policy?: GuardianPolicy;
}

export interface ValidationResult {
  decision: Decision;
  checks: Check[];
  reasons: string[];
  minOut: bigint;
  refAmountOut: bigint;
  expectedNetValueUsdt: number;
  economics: {
    amountInUsdt: number;
    quotedOut: bigint;
    impactBps: number | null;
    edgeBps: number | null;
    gasUsdt: number;
    exitCostUsdt: number;
    referencePrice: number | null;
    dexSpot: number;
  };
  plan: ExecutionPlan;
}

const fromRaw = (x: bigint, d: number) => Number(x) / 10 ** d;
const toRaw = (x: number, d: number) => BigInt(Math.floor(x * 10 ** Math.min(d, 15))) * 10n ** BigInt(Math.max(0, d - 15));

/**
 * Execution Guardian (Stage 9) + Portfolio Risk (Stage 10) + Adaptive Execution (Stage 11).
 * Pure and deterministic. It does not read the AI's rationale or confidence — only the intent
 * (asset, side, size, tier) and, for tier C, the committed prediction's probability/levels.
 */
export function validate(inp: ValidationInput): ValidationResult {
  const pol = inp.policy ?? DEFAULT_GUARDIAN_POLICY;
  const { proposal: p, health: h, vault: v } = inp;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const isBuy = p.side === "BUY";
  const amountIn = BigInt(p.amountIn);
  const qd = inp.quoteDecimals;
  const bd = inp.baseDecimals;
  const feeFrac = inp.feePpm / 1e6;
  const single = inp.quotes.find((q) => q.legs === 1)!;
  const quotedOut = single.amountOutPerLeg;
  const ref = h.reference;
  const spot = h.dexSpot;

  const amountInUsdt = isBuy ? fromRaw(amountIn, qd) : fromRaw(amountIn, bd) * spot;
  const gasUsdt = (Number(inp.gasPriceWei) * pol.gasUnits) / 1e18 * inp.hskUsd;

  // ---------------- data & chain
  add({ name: "chain-state", pass: inp.chainStatus === "VALID" || inp.chainStatus === "WARNING", severity: inp.chainStatus === "REJECT" ? "hard" : "soft", value: inp.chainStatus });
  add({ name: "market-data", pass: isTradable(h), severity: h.status === "REJECT" ? "hard" : "soft", value: h.status, note: h.findings.filter((f) => f.status !== "VALID").map((f) => f.message).join("; ") || undefined });

  // ---------------- mandate mirror (the contract enforces these too; we fail early and explain)
  const m = v.mandate;
  const pos = v.positions.find((x) => x.asset === p.asset);
  add({ name: "mandate-expiry", pass: BigInt(inp.nowSec) <= m.expiry, severity: "hard", value: inp.nowSec, limit: Number(m.expiry) });
  if (isBuy) {
    const tierOk = p.tier === "B" || p.tier === "C" ? (m.tiersMask & tierBit(p.tier)) !== 0 : false;
    add({ name: "tier-allowed", pass: tierOk, severity: "hard", value: p.tier, limit: m.tiersMask });
    add({ name: "asset-allowed", pass: !!pos && (m.assetsMask & (1 << pos.index)) !== 0, severity: "hard", value: p.asset });
    add({ name: "not-paused", pass: !v.paused, severity: "hard" });
    add({ name: "per-trade-cap", pass: amountIn <= m.maxTradeQuote, severity: "hard", value: fromRaw(amountIn, qd), limit: fromRaw(m.maxTradeQuote, qd) });
    const vol = v.dayVolume + inp.reservations.volume + amountIn;
    add({ name: "daily-volume", pass: vol <= m.dailyVolumeQuote, severity: "hard", value: fromRaw(vol, qd), limit: fromRaw(m.dailyVolumeQuote, qd) });
    const lossHit = v.dayPnl < 0n && -v.dayPnl >= m.dailyLossQuote;
    add({ name: "daily-loss", pass: !lossHit, severity: "hard", value: fromRaw(v.dayPnl, qd), limit: -fromRaw(m.dailyLossQuote, qd) });
    const reservedExp = inp.reservations.exposure.get(p.asset) ?? 0n;
    const exp = (pos?.cost ?? 0n) + reservedExp + amountIn;
    add({ name: "asset-exposure", pass: exp <= m.maxExposureQuote, severity: "hard", value: fromRaw(exp, qd), limit: fromRaw(m.maxExposureQuote, qd) });
    const cash = v.quoteBalance - inp.reservations.quote;
    add({ name: "available-cash", pass: cash >= amountIn, severity: "hard", value: fromRaw(cash, qd), limit: fromRaw(amountIn, qd) });
    const readyAt = v.lastEntryAt + m.cooldown;
    add({ name: "cooldown", pass: v.lastEntryAt === 0 || inp.nowSec >= readyAt, severity: "soft", value: inp.nowSec, limit: readyAt });
    // v2: no re-entry right after a stop-loss; drawdown breaker (owner-reset only)
    const lockedUntil = pos?.reentryBlockedUntil ?? 0;
    add({ name: "reentry-lockout", pass: inp.nowSec >= lockedUntil, severity: "soft", value: inp.nowSec, limit: lockedUntil, note: "buys are refused for 1h after a stop-loss" });
    if (m.maxDrawdownBps > 0) {
      const floor = (v.highWaterMark * BigInt(10_000 - m.maxDrawdownBps)) / 10_000n;
      const ok = !v.breakerTripped && (v.highWaterMark === 0n || v.nav === null || v.nav >= floor);
      add({ name: "drawdown-breaker", pass: ok, severity: "hard", value: v.nav === null ? null : fromRaw(v.nav, qd), limit: fromRaw(floor, qd), note: v.breakerTripped ? "breaker tripped: only the owner can reset it" : "NAV vs high-water mark" });
    }
  } else {
    add({ name: "tracked-inventory", pass: !!pos && amountIn <= pos.qty, severity: "hard", value: pos ? fromRaw(pos.qty, bd) : 0, limit: fromRaw(amountIn, bd) });
    if (p.tier !== "EXIT") add({ name: "tier-allowed", pass: p.tier !== "A" && (m.tiersMask & tierBit(p.tier)) !== 0, severity: "hard", value: p.tier });
  }

  // ---------------- quote, floor, impact
  const minOut = (quotedOut * BigInt(10_000 - pol.execSlippageBps)) / 10_000n;
  add({ name: "quote-available", pass: quotedOut > 0n, severity: "hard", value: quotedOut.toString() });
  add({ name: "twap-floor", pass: minOut >= inp.twapFloor, severity: "hard", value: minOut.toString(), limit: inp.twapFloor.toString(), note: "minOut must clear the vault's TWAP floor or the vault will revert" });
  const effPrice = isBuy ? fromRaw(amountIn, qd) / fromRaw(quotedOut, bd) : fromRaw(quotedOut, qd) / fromRaw(amountIn, bd);
  const impactBps = Number.isFinite(spot) && spot > 0
    ? isBuy
      ? (effPrice / (spot / (1 - feeFrac)) - 1) * 10_000
      : (1 - effPrice / (spot * (1 - feeFrac))) * 10_000
    : null;
  add({ name: "price-impact", pass: impactBps !== null && impactBps <= pol.maxImpactBps, severity: "hard", value: impactBps === null ? null : +impactBps.toFixed(2), limit: pol.maxImpactBps });

  // ---------------- reference & edge
  let refAmountOut = 0n;
  let edgeBps: number | null = null;
  if (ref !== null && ref > 0) {
    refAmountOut = isBuy ? toRaw(fromRaw(amountIn, qd) / ref, bd) : toRaw(fromRaw(amountIn, bd) * ref, qd);
    edgeBps = refAmountOut > 0n ? (Number(minOut) / Number(refAmountOut) - 1) * 10_000 : null;
  }
  if (p.tier === "B") {
    const required = (refAmountOut * BigInt(10_000 + m.minEdgeBps) + 9_999n) / 10_000n;
    add({ name: "edge-or-revert", pass: refAmountOut > 0n && minOut >= required, severity: "soft", value: edgeBps === null ? null : +edgeBps.toFixed(1), limit: m.minEdgeBps, note: "fill must beat the reference by the mandate's minimum edge" });
  }
  if (p.tier === "C") {
    add({ name: "sworn-prediction", pass: !!p.predictionHash && !!p.prediction && !!p.strategist, severity: "hard" });
  }

  // ---------------- costs & expected net value
  const exitFrac = feeFrac + Math.max(0, impactBps ?? 0) / 10_000;
  let expectedNet = 0;
  let exitCostUsdt = 0;
  if (isBuy) {
    const outHuman = fromRaw(minOut, bd);
    const markRef = ref ?? spot;
    exitCostUsdt = outHuman * markRef * exitFrac + gasUsdt;
    if (p.tier === "C" && p.strategist) {
      const s = p.strategist;
      const up = (s.target - spot) / spot;
      const down = (spot - s.invalidation) / spot;
      const valueAtSpot = outHuman * spot;
      expectedNet = valueAtSpot * (1 + s.probability * up - (1 - s.probability) * down) - amountInUsdt - exitCostUsdt - gasUsdt;
    } else {
      // net value of the position marked at the reference, after a full round trip of costs
      expectedNet = outHuman * markRef - amountInUsdt - exitCostUsdt - gasUsdt;
    }
    const floorUsdt = Math.max(pol.minNetValueUsdt, fromRaw(m.minNetValueQuote ?? 0n, qd));
    add({ name: "expected-net-value", pass: expectedNet > floorUsdt, severity: "soft", value: +expectedNet.toFixed(6), limit: floorUsdt, note: "after entry fee, impact, exit fee and gas both ways (the vault also refuses a non-positive signed expectation)" });
  } else {
    const costPortion = pos && pos.qty > 0n ? fromRaw((pos.cost * amountIn) / pos.qty, qd) : 0;
    expectedNet = fromRaw(minOut, qd) - costPortion - gasUsdt; // informational: exits are risk-reducing
  }

  // ---------------- portfolio risk (entries only)
  if (isBuy) {
    const priceOf = (a: string) => (a === p.asset ? spot : NaN);
    const vaultValue = usdt(v.quoteBalance, qd) + v.positions.reduce((acc, x) => acc + (x.asset === p.asset ? fromRaw(x.qty, x.decimals) * spot : usdt(x.cost, qd)), 0);
    const assetAfter = (pos ? fromRaw(pos.qty, bd) * priceOf(p.asset) : 0) + amountInUsdt;
    const allAfter = v.positions.reduce((acc, x) => acc + (x.asset === p.asset ? fromRaw(x.qty, x.decimals) * spot : usdt(x.cost, qd)), 0) + amountInUsdt;
    const conc = vaultValue > 0 ? (assetAfter / vaultValue) * 100 : 100;
    const tot = vaultValue > 0 ? (allAfter / vaultValue) * 100 : 100;
    add({ name: "concentration", pass: conc <= pol.maxConcentrationPct, severity: "hard", value: +conc.toFixed(1), limit: pol.maxConcentrationPct, note: `${p.asset} share of vault value after the trade (%)` });
    add({ name: "total-exposure", pass: tot <= pol.maxTotalExposurePct, severity: "hard", value: +tot.toFixed(1), limit: pol.maxTotalExposurePct, note: "non-USDT share of vault value after the trade (%)" });
  }

  // ---------------- adaptive execution plan
  const plan = adaptivePlan(inp, minOut, gasUsdt, pol);

  const hardFail = checks.filter((c) => !c.pass && c.severity === "hard");
  const softFail = checks.filter((c) => !c.pass && c.severity === "soft");
  const decision: Decision = hardFail.length ? "REJECT" : softFail.length ? "WAIT" : "APPROVE";
  const reasons = [...hardFail, ...softFail].map(
    (c) => `${c.name}${c.value !== undefined ? ` (${c.value}${c.limit !== undefined ? ` vs ${c.limit}` : ""})` : ""}${c.note ? `: ${c.note}` : ""}`,
  );
  return {
    decision,
    checks,
    reasons,
    minOut,
    refAmountOut,
    expectedNetValueUsdt: expectedNet,
    economics: { amountInUsdt, quotedOut, impactBps, edgeBps, gasUsdt, exitCostUsdt, referencePrice: ref, dexSpot: spot },
    plan: decision === "APPROVE" ? plan : { ...plan, method: "WAIT", legs: [], reason: decision === "WAIT" ? "conditions not met yet" : "rejected" },
  };
}

/** Stage 11 — compare one order with 2 and 3 equal legs (legs are spaced by the vault cooldown). */
export function adaptivePlan(inp: ValidationInput, minOutSingle: bigint, gasUsdt: number, pol: GuardianPolicy): ExecutionPlan {
  const isBuy = inp.proposal.side === "BUY";
  const outDec = isBuy ? inp.baseDecimals : inp.quoteDecimals;
  const px = isBuy ? inp.health.dexSpot : 1; // value one unit of output in USDT
  const single = inp.quotes.find((q) => q.legs === 1)!;
  const singleVal = fromRaw(single.amountOutPerLeg, outDec) * px;
  const comparison = inp.quotes
    .slice()
    .sort((a, b) => a.legs - b.legs)
    .map((q) => {
      const total = q.amountOutPerLeg * BigInt(q.legs);
      const extraGas = (q.legs - 1) * gasUsdt;
      return {
        legs: q.legs,
        outPerLeg: q.amountOutPerLeg.toString(),
        totalOut: total.toString(),
        extraGasUsdt: +extraGas.toFixed(6),
        netVsSingleUsdt: +(fromRaw(total, outDec) * px - singleVal - extraGas).toFixed(6),
      };
    });
  const best = comparison.reduce((a, b) => (b.netVsSingleUsdt > a.netVsSingleUsdt ? b : a), comparison[0]!);
  const cooldown = isBuy ? inp.vault.mandate.cooldown : 0;
  if (best.legs === 1 || best.netVsSingleUsdt <= 0) {
    return {
      method: "IMMEDIATE",
      legs: [{ index: 0, amountIn: inp.proposal.amountIn, minOut: minOutSingle.toString(), notBefore: inp.nowSec }],
      comparison,
      reason: "splitting does not improve output enough to pay for extra gas and delay",
    };
  }
  const q = inp.quotes.find((x) => x.legs === best.legs)!;
  const legMin = (q.amountOutPerLeg * BigInt(10_000 - pol.execSlippageBps)) / 10_000n;
  return {
    method: "SPLIT",
    legs: Array.from({ length: best.legs }, (_, i) => ({ index: i, amountIn: q.amountInPerLeg.toString(), minOut: legMin.toString(), notBefore: inp.nowSec + i * cooldown })),
    comparison,
    reason: `${best.legs} legs improve output by ${best.netVsSingleUsdt.toFixed(4)} USDT after extra gas`,
  };
}
