import type { MarketHealth } from "../data-reliability/engine.js";
import { isTradable } from "../data-reliability/engine.js";
import { tierBit, type VaultState } from "../vault/state.js";
import type { Candidate } from "../strategies/types.js";

export interface FilterVerdict {
  candidate: Candidate;
  pass: boolean;
  reasons: string[];
  /** "WAIT" = conditions may clear soon (cooldown, data), "REJECT" = structurally not allowed */
  outcome: "PASS" | "WAIT" | "REJECT";
}

/**
 * Strategy Filter (Stage 7) — deterministic, runs BEFORE the LLM so the model is never asked
 * about something the mandate or the data already rules out.
 */
export function filterCandidates(
  cands: Candidate[],
  health: MarketHealth,
  v: VaultState,
  now: number,
  opts: { inFlightAssets?: Set<string> } = {},
): FilterVerdict[] {
  const nowSec = Math.floor(now / 1000);
  // conflicting signals on the same asset in one tick cancel each other
  const sides = new Map<string, Set<string>>();
  for (const c of cands) sides.set(c.asset, (sides.get(c.asset) ?? new Set()).add(c.side));

  return cands.map((c) => {
    const reject: string[] = [];
    const wait: string[] = [];
    const h = health.assets.find((a) => a.asset === c.asset);
    const pos = v.positions.find((p) => p.asset === c.asset);
    const isEntry = c.side === "BUY";

    if (!h || !isTradable(h)) wait.push(`market data for ${c.asset} is ${h?.status ?? "missing"}`);
    if (now > c.expiresAt) reject.push("signal expired");
    if (BigInt(nowSec) > v.mandate.expiry) reject.push("mandate expired");
    if (!(v.mandate.tiersMask & tierBit(c.tier))) reject.push(`tier ${c.tier} disabled by mandate (risk appetite)`);
    if (isEntry) {
      if (v.paused) reject.push("vault paused — entries blocked");
      if (pos && !(v.mandate.assetsMask & (1 << pos.index))) reject.push(`${c.asset} not in target assets`);
      const readyAt = v.lastEntryAt + v.mandate.cooldown;
      if (v.lastEntryAt && nowSec < readyAt) wait.push(`cooldown: ${readyAt - nowSec}s left`);
      if (v.dayPnl < 0n && -v.dayPnl >= v.mandate.dailyLossQuote) reject.push("daily loss limit reached");
    } else if (!pos || pos.qty === 0n) {
      reject.push(`no tracked ${c.asset} to sell`);
    }
    if ((sides.get(c.asset)?.size ?? 0) > 1) reject.push("conflicting BUY and SELL signals this tick");
    if (opts.inFlightAssets?.has(c.asset)) wait.push(`a ${c.asset} trade is already in flight`);
    if (c.grossEdgeBps <= 0) reject.push(`no gross edge after fee and impact (${c.grossEdgeBps.toFixed(0)} bps)`);

    const outcome = reject.length ? "REJECT" : wait.length ? "WAIT" : "PASS";
    return { candidate: c, pass: outcome === "PASS", reasons: [...reject, ...wait], outcome };
  });
}
