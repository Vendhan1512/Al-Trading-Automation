import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";
import type { AssetSymbol, NetworkConfig } from "../config.js";
import type { Store } from "../common/store.js";
import type { MarketHealth } from "../modules/data-reliability/engine.js";
import { meanReversionCandidates, scanCycles, spreadCandidates } from "../modules/strategies/candidates.js";
import { filterCandidates } from "../modules/strategy-filter/filter.js";
import { decide, type StrategistDecision } from "../modules/ai-strategist/strategist.js";
import { canonicalJson, makePrediction, type Prediction } from "../modules/predictions/prediction.js";
import { paperVaultState, readVaultState, tierBit, type VaultState } from "../modules/vault/state.js";
import { evaluatePositions, gradePredictions } from "../modules/positions/positions.js";
import { circuitBreaker, computeMetrics } from "../modules/strategy-health/health.js";
import type { GuardianClient } from "../modules/execution/guardian-client.js";
import type { ChainOps, TxManager } from "../modules/transactions/tx-manager.js";
import type { GuardianResponse, Proposal } from "../guardian/types.js";
import type { Candidate } from "../modules/strategies/types.js";

export type AgentMode = "shadow" | "live";

export interface PipelineCtx {
  net: NetworkConfig;
  client: PublicClient;
  store: Store;
  guardian: GuardianClient;
  tx: TxManager | null; // live mode only
  ops: ChainOps | null; // live mode only (circuit-breaker actions)
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
  exits: number;
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

/** Guardian → (live) submit → settle. Returns a one-line result and whether a fill confirmed. */
async function countersignAndExecute(
  ctx: PipelineCtx,
  proposal: Proposal,
  prediction: Prediction | null,
): Promise<{ g: GuardianResponse | null; line: string; executed: boolean; txStatus: string | null; unreachable?: string }> {
  const dryRun = ctx.mode !== "live" || !ctx.vault || !ctx.tx;
  const g = await ctx.guardian.evaluate(proposal, dryRun);
  if ("unreachable" in g) return { g: null, line: `Guardian unreachable (${g.unreachable}); no trade without a countersignature`, executed: false, txStatus: null, unreachable: g.unreachable };
  const e = g.economics;
  const econ = `${(e?.amountInUsdt ?? 0).toFixed(4)} USDT — edge ${e?.edgeBps?.toFixed(0) ?? "—"} bps, net ${(e?.expectedNetValueUsdt ?? 0).toFixed(4)} USDT`;
  if (g.decision !== "APPROVE" || dryRun || !g.permit || !g.signature || !g.path) {
    const tag = dryRun && g.decision === "APPROVE" ? "APPROVE(dry-run)" : g.decision;
    return { g, line: `${tag} ${econ}${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`, executed: false, txStatus: null };
  }
  ctx.inFlight.add(proposal.asset);
  try {
    const sub = await ctx.tx!.submit({ vault: ctx.vault!, proposalId: proposal.proposalId, asset: proposal.asset, side: proposal.side, tier: proposal.tier, path: g.path, permit: g.permit, signature: g.signature, predictionHash: proposal.predictionHash });
    if (sub.status !== "SUBMITTED") return { g, line: `APPROVE ${econ} — not sent: ${sub.status} (${sub.reason})`, executed: false, txStatus: sub.status };
    const row = await ctx.tx!.settle(g.permit.tradeId);
    const status = row?.status ?? "UNKNOWN";
    if (status === "CONFIRMED" && prediction && proposal.predictionHash) {
      ctx.store.recordPrediction({
        hash: proposal.predictionHash,
        tradeId: g.permit.tradeId,
        asset: prediction.asset,
        direction: prediction.direction,
        entry: prediction.entryRef,
        target: prediction.target,
        invalidation: prediction.invalidation,
        probability: prediction.probability,
        expiresAt: prediction.expiresAt,
        createdAt: prediction.createdAt,
        payload: prediction,
      });
    }
    return { g, line: `APPROVE ${econ} — tx ${status} ${row?.hash ?? sub.hash}`, executed: status === "CONFIRMED", txStatus: status };
  } finally {
    ctx.inFlight.delete(proposal.asset);
    if (g.permit) await ctx.guardian.release(g.permit.tradeId);
  }
}

/**
 * One autonomous decision cycle:
 *  reconcile txs (14) → read vault → grade predictions → manage exits (16, no LLM) →
 *  candidates → filter (7) → strategist (6) → sworn prediction (8) → Guardian (9–11) →
 *  submit (12–13) → strategy health + circuit breaker (17–18).
 * Every step that decides something leaves a sequenced journal entry.
 */
export async function runPipeline(ctx: PipelineCtx, health: MarketHealth): Promise<TickSummary> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const lines: string[] = [];
  const journal = (kind: string, asset: string | null, outcome: string, summary: string, payload: unknown) => {
    ctx.store.recordDecision({ at: now, kind, asset, outcome, summary, payload, hash: hashOf({ now, kind, summary, payload }) });
    lines.push(summary);
  };

  // 14 — reconcile in-flight transactions against the chain before anything new
  if (ctx.tx) for (const r of await ctx.tx.reconcile()) journal("tx", null, r.to, `tx ${r.tradeId.slice(0, 10)} ${r.from}→${r.to}: ${r.note}`, r);

  let vault: VaultState;
  try {
    vault = ctx.vault ? await readVaultState(ctx.client, ctx.net, ctx.vault) : paperVaultState(ctx.net);
  } catch (e) {
    journal("tick", null, "WAIT", `vault read failed: ${(e as Error).message.split("\n")[0]} — no trading this tick`, {});
    return { at: now, vaultMode: "onchain", candidates: 0, passed: 0, taken: 0, approved: 0, executed: 0, exits: 0, strategist: "-", lines };
  }

  // grade sworn predictions (calibration is tracked separately from P&L)
  for (const r of gradePredictions(ctx.store.openPredictions(), health, nowSec)) {
    ctx.store.resolvePrediction(r.hash, r.outcome, r.price);
    journal("prediction", null, r.outcome, `prediction ${r.hash.slice(0, 10)} → ${r.outcome} at ${r.price.toPrecision(6)}`, r);
  }

  let approved = 0;
  let executed = 0;
  let exits = 0;

  // 16 — exits for open positions: deterministic, never routed through the LLM
  for (const pos of evaluatePositions(ctx.net, vault, health, ctx.store.predictions(), nowSec)) {
    if (!pos.exit || ctx.inFlight.has(pos.asset)) continue;
    const proposal: Proposal = { proposalId: `exit-${pos.asset}-${now}`, vault: ctx.vault, tier: "EXIT", asset: pos.asset as AssetSymbol, side: "SELL", amountIn: pos.qtyRaw.toString(), prediction: null, predictionHash: null, strategist: null, candidateId: null };
    const r = await countersignAndExecute(ctx, proposal, null);
    if (r.g?.decision === "APPROVE") approved++;
    if (r.executed) (executed++, exits++);
    journal("exit", pos.asset, r.executed ? "EXECUTED" : (r.g?.decision ?? "WAIT"), `EXIT ${pos.asset} ${pos.exit.reason} (${pos.exit.detail}; uPnL ${pos.unrealizedPnlUsdt.toFixed(4)} USDT) — ${r.line}`, { position: { ...pos, qtyRaw: pos.qtyRaw.toString() }, proposal, guardian: r.g });
  }

  const cycles = scanCycles(ctx.net, now);
  const cands = [
    ...spreadCandidates(ctx.net, health, vault, now),
    ...meanReversionCandidates(ctx.net, health, vault, (a: AssetSymbol) => ctx.store.dexSeries(a, 120), now),
  ];
  const verdicts = filterCandidates(cands, health, vault, now, { inFlightAssets: ctx.inFlight });
  const passed = verdicts.filter((x) => x.pass).map((x) => x.candidate);
  const strat = await decide(passed, health, vault);

  if (cands.length === 0) {
    const why = health.assets.map((a) => `${a.asset} ${a.status} ${a.premiumBps === null ? "no ref" : `${a.premiumBps >= 0 ? "+" : ""}${a.premiumBps.toFixed(0)}bps`}`).join(" · ");
    const cash = Number(vault.quoteBalance) / 10 ** vault.quoteDecimals;
    const power = cash < 0.1 ? ` · no buying power (vault holds ${cash.toFixed(2)} USDT)` : "";
    journal("tick", null, "WAIT", `WAIT — no candidate (${why})${power}; Tier A: ${cycles.note}`, { health: health.assets.map((a) => ({ asset: a.asset, status: a.status, premiumBps: a.premiumBps })), cycles });
  }

  for (const v of verdicts) {
    const c = v.candidate;
    const base = { candidate: c, filter: { outcome: v.outcome, reasons: v.reasons } };
    const label = `${c.tier}/${c.asset} ${c.side}`;
    if (!v.pass) {
      journal("candidate", c.asset, v.outcome, `${v.outcome} ${label} — filter: ${v.reasons.join("; ")}`, base);
      continue;
    }
    const d = strat.decisions.find((x) => x.candidateId === c.id)!;
    if (d.action === "SKIP") {
      journal("candidate", c.asset, "SKIP", `SKIP ${label} — strategist (${strat.source}): ${d.rationale}`, { ...base, strategist: d, regime: strat.regime, note: strat.note });
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
      expiresAt: nowSec + d.horizonSec,
      createdAt: nowSec,
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
    const r = await countersignAndExecute(ctx, proposal, prediction);
    if (r.g?.decision === "APPROVE") approved++;
    if (r.executed) executed++;
    const outcome = r.executed ? "EXECUTED" : r.unreachable ? "WAIT" : (r.g?.decision ?? "WAIT");
    journal("candidate", c.asset, outcome, `${label} ${r.line}`, { ...base, strategist: d, regime: strat.regime, prediction, predictionHash, proposal, guardian: r.g, txStatus: r.txStatus });
  }

  // 17–18 — strategy health; the breaker can only restrict (pause / drop tier C), never loosen
  const hskUsd = health.assets.find((a) => a.asset === "WHSK")?.reference ?? 0.08;
  const metrics = computeMetrics(ctx.store.trades(), ctx.store.predictions(), ctx.store.txRecent(500), hskUsd, vault.quoteDecimals);
  for (const a of circuitBreaker(metrics)) {
    if (ctx.mode !== "live" || !ctx.ops || !ctx.vault) {
      journal("breaker", null, "ADVISORY", `circuit breaker (advisory, ${ctx.mode}): ${a.kind} — ${a.reason}`, { action: a, metrics });
      continue;
    }
    try {
      if (a.kind === "PAUSE" && !vault.paused) {
        const h = await ctx.ops.pause(ctx.vault);
        journal("breaker", null, "PAUSED", `circuit breaker PAUSED the vault — ${a.reason} (tx ${h})`, { action: a, metrics, tx: h });
      } else if (a.kind === "DISABLE_TIER_C" && vault.mandate.tiersMask & tierBit("C")) {
        const h = await ctx.ops.tighten(ctx.vault, { ...vault.mandate, tiersMask: vault.mandate.tiersMask & ~tierBit("C") });
        journal("breaker", null, "TIGHTENED", `circuit breaker disabled tier C — ${a.reason} (tx ${h})`, { action: a, metrics, tx: h });
      }
    } catch (e) {
      journal("breaker", null, "FAILED", `circuit breaker action ${a.kind} failed: ${(e as Error).message.split("\n")[0]}`, { action: a });
    }
  }

  return {
    at: now,
    vaultMode: vault.mode,
    candidates: cands.length,
    passed: passed.length,
    taken: strat.decisions.filter((x) => x.action === "TAKE").length,
    approved,
    executed,
    exits,
    strategist: `${strat.source}${strat.note ? ` (${strat.note})` : ""}`,
    lines,
  };
}

export type { Hex };
