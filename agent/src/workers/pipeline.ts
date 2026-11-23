import { keccak256, toBytes, type Address, type PublicClient } from "viem";
import type { AssetSymbol, NetworkConfig } from "../config.js";
import type { Store } from "../common/store.js";
import type { MarketHealth } from "../modules/data-reliability/engine.js";
import { meanReversionCandidates, scanCycles, spreadCandidates } from "../modules/strategies/candidates.js";
import { filterCandidates } from "../modules/strategy-filter/filter.js";
import { decide, type StrategistDecision } from "../modules/ai-strategist/strategist.js";
import { canonicalJson, makePrediction } from "../modules/predictions/prediction.js";
import { paperVaultState, readVaultState, type VaultState } from "../modules/vault/state.js";
import type { GuardianClient } from "../modules/execution/guardian-client.js";
import type { Executor } from "../modules/execution/executor.js";
import type { Proposal } from "../guardian/types.js";
import type { Candidate } from "../modules/strategies/types.js";

export type AgentMode = "shadow" | "live";

export interface PipelineCtx {
  net: NetworkConfig;
  client: PublicClient;
  store: Store;
  guardian: GuardianClient;
  executor: Executor | null;
  vault: Address | null;
  mode: AgentMode;
  agentId: string;
  inFlight: Set<string>;
  log: (s: string) => void;
}

export interface TickSummary {
  at: number;
  vaultMode: "onchain" | "paper";
  candidates: number;
  passed: number;
  taken: number;
  approved: number;
  executed: number;
  strategist: string;
  lines: string[];
}

const hashOf = (x: unknown) => keccak256(toBytes(canonicalJson(JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))))));

function toRawAmount(c: Candidate, d: StrategistDecision, v: VaultState, net: NetworkConfig): bigint {
  const pool = net.pools.find((p) => p.asset === c.asset)!;
  if (c.side === "BUY") return BigInt(Math.floor(d.sizeUsdt * 10 ** pool.quote.decimals));
  const pos = v.positions.find((p) => p.asset === c.asset)!;
  const qty = BigInt(Math.floor((d.sizeUsdt / c.entry) * 10 ** Math.min(pool.base.decimals, 15))) * 10n ** BigInt(Math.max(0, pool.base.decimals - 15));
  return qty > pos.qty ? pos.qty : qty;
}

/**
 * One autonomous decision cycle (Stages 6–12):
 * candidates → Strategy Filter → AI Strategist → Sworn Prediction → Guardian → (live) execution.
 * Every candidate, and every quiet tick, becomes a sequenced journal entry.
 */
export async function runPipeline(ctx: PipelineCtx, health: MarketHealth): Promise<TickSummary> {
  const now = Date.now();
  const lines: string[] = [];
  let vault: VaultState;
  try {
    vault = ctx.vault ? await readVaultState(ctx.client, ctx.net, ctx.vault) : paperVaultState(ctx.net);
  } catch (e) {
    const msg = `vault read failed: ${(e as Error).message.split("\n")[0]} — no trading this tick`;
    ctx.store.recordDecision({ at: now, kind: "tick", asset: null, outcome: "WAIT", summary: msg, payload: { health: health.status }, hash: hashOf({ now, msg }) });
    return { at: now, vaultMode: "onchain", candidates: 0, passed: 0, taken: 0, approved: 0, executed: 0, strategist: "-", lines: [msg] };
  }

  const cycles = scanCycles(ctx.net, now);
  const cands = [
    ...spreadCandidates(ctx.net, health, vault, now),
    ...meanReversionCandidates(ctx.net, health, vault, (a: AssetSymbol) => ctx.store.dexSeries(a, 120), now),
  ];
  const verdicts = filterCandidates(cands, health, vault, now, { inFlightAssets: ctx.inFlight });
  const passed = verdicts.filter((x) => x.pass).map((x) => x.candidate);
  const strat = await decide(passed, health, vault);
  let approved = 0;
  let executed = 0;

  if (cands.length === 0) {
    const why = health.assets
      .map((a) => `${a.asset} ${a.status} ${a.premiumBps === null ? "no ref" : `${a.premiumBps >= 0 ? "+" : ""}${a.premiumBps.toFixed(0)}bps`}`)
      .join(" · ");
    const summary = `WAIT — no candidate (${why}); Tier A: ${cycles.note}`;
    ctx.store.recordDecision({ at: now, kind: "tick", asset: null, outcome: "WAIT", summary, payload: { health: health.assets.map((a) => ({ asset: a.asset, status: a.status, premiumBps: a.premiumBps })), cycles }, hash: hashOf({ now, summary }) });
    lines.push(summary);
  }

  for (const v of verdicts) {
    const c = v.candidate;
    const base = { candidate: c, filter: { outcome: v.outcome, reasons: v.reasons } };
    if (!v.pass) {
      const summary = `${v.outcome} ${c.tier}/${c.asset} ${c.side} — filter: ${v.reasons.join("; ")}`;
      ctx.store.recordDecision({ at: now, kind: "candidate", asset: c.asset, outcome: v.outcome, summary, payload: base, hash: hashOf({ now, base }) });
      lines.push(summary);
      continue;
    }
    const d = strat.decisions.find((x) => x.candidateId === c.id)!;
    if (d.action === "SKIP") {
      const summary = `SKIP ${c.tier}/${c.asset} ${c.side} — strategist (${strat.source}): ${d.rationale}`;
      ctx.store.recordDecision({ at: now, kind: "candidate", asset: c.asset, outcome: "SKIP", summary, payload: { ...base, strategist: d, regime: strat.regime, note: strat.note }, hash: hashOf({ now, base, d }) });
      lines.push(summary);
      continue;
    }

    const { prediction, hash: predictionHash } = makePrediction({
      agentId: ctx.agentId,
      strategyId: c.strategyId,
      vault: ctx.vault,
      chainId: ctx.net.chainId,
      asset: c.asset,
      direction: c.side,
      entryRef: c.entry,
      target: d.target,
      invalidation: d.invalidation,
      probability: d.probability,
      expiresAt: Math.floor(now / 1000) + d.horizonSec,
      createdAt: Math.floor(now / 1000),
      candidateId: c.id,
    });
    const proposal: Proposal = {
      proposalId: `${c.id}-${now}`,
      vault: ctx.vault,
      tier: c.tier,
      asset: c.asset,
      side: c.side,
      amountIn: toRawAmount(c, d, vault, ctx.net).toString(),
      prediction: prediction as unknown as Record<string, unknown>,
      predictionHash,
      strategist: { source: d.source, probability: d.probability, target: d.target, invalidation: d.invalidation },
      candidateId: c.id,
    };
    const dryRun = ctx.mode !== "live" || !ctx.vault;
    const g = await ctx.guardian.evaluate(proposal, dryRun);
    if ("unreachable" in g) {
      const summary = `WAIT ${c.tier}/${c.asset} ${c.side} — Guardian unreachable (${g.unreachable}); no trade without a countersignature`;
      ctx.store.recordDecision({ at: now, kind: "candidate", asset: c.asset, outcome: "WAIT", summary, payload: { ...base, strategist: d, prediction, proposal }, hash: hashOf({ now, proposal }) });
      lines.push(summary);
      continue;
    }
    if (g.decision === "APPROVE") approved++;
    let execution = null;
    if (g.decision === "APPROVE" && !dryRun && ctx.executor && g.permit && g.signature && g.path) {
      ctx.inFlight.add(c.asset);
      try {
        execution = await ctx.executor.execute(ctx.vault!, g.path, g.permit, g.signature);
        if (execution.status === "CONFIRMED") executed++;
      } finally {
        ctx.inFlight.delete(c.asset);
        await ctx.guardian.release(g.permit.tradeId);
      }
    }
    const e = g.economics;
    const tag = dryRun && g.decision === "APPROVE" ? "APPROVE(dry-run)" : g.decision;
    const summary = `${tag} ${c.tier}/${c.asset} ${c.side} ${(e?.amountInUsdt ?? 0).toFixed(4)} USDT — edge ${e?.edgeBps?.toFixed(0) ?? "—"} bps, net ${(e?.expectedNetValueUsdt ?? 0).toFixed(4)} USDT${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}${execution ? ` — tx ${execution.status} ${execution.txHash ?? execution.error ?? ""}` : ""}`;
    ctx.store.recordDecision({
      at: now,
      kind: "candidate",
      asset: c.asset,
      outcome: execution?.status === "CONFIRMED" ? "EXECUTED" : g.decision,
      summary,
      payload: { ...base, strategist: d, regime: strat.regime, prediction, predictionHash, proposal, guardian: g, execution },
      hash: hashOf({ now, proposal, decisionHash: g.decisionHash, execution }),
    });
    lines.push(summary);
  }

  return {
    at: now,
    vaultMode: vault.mode,
    candidates: cands.length,
    passed: passed.length,
    taken: strat.decisions.filter((x) => x.action === "TAKE").length,
    approved,
    executed,
    strategist: `${strat.source}${strat.note ? ` (${strat.note})` : ""}`,
    lines,
  };
}
