import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from "viem";
import { countersignVaultAbi } from "../src/abi/countersignVault.js";
import { Store, type PredictionRow, type TradeRow, type TxRow } from "../src/common/store.js";
import { MAINNET } from "../src/config.js";
import { evaluateMarket } from "../src/modules/data-reliability/engine.js";
import { evaluatePositions, gradePredictions } from "../src/modules/positions/positions.js";
import { circuitBreaker, computeMetrics } from "../src/modules/strategy-health/health.js";
import { TxManager, type ChainOps, type TxMeta } from "../src/modules/transactions/tx-manager.js";
import { paperVaultState } from "../src/modules/vault/state.js";
import type { PermitJson } from "../src/guardian/types.js";
import { NOW, cex, snap, pool } from "./fixtures.js";

const VAULT = "0x76fB3ae6c48964171a297C88a16513284CfB9eE0" as Address;
const Z = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const tid = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;

function fillLog(tradeId: Hex, amountIn: bigint, amountOut: bigint, pnl: bigint): Log {
  return {
    address: VAULT,
    topics: encodeEventTopics({ abi: countersignVaultAbi, eventName: "TradeExecuted", args: { tradeId, tier: 2 } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "int256" }, { type: "int256" }, { type: "bytes32" }, { type: "bytes32" }],
      [1, MAINNET.quote.address, MAINNET.pools[2]!.base.address, amountIn, amountOut, 0n, 15_000n, pnl, Z, Z],
    ),
    blockHash: Z, blockNumber: 100n, logIndex: 0, transactionHash: Z, transactionIndex: 0, removed: false,
  } as Log;
}

/** A scriptable fake chain. */
class FakeChain implements ChainOps {
  agent = "0x170912F2F8beb252902e9b07F63851B2e284bEA7" as Address;
  latest = 10;
  pending = 10;
  used = new Set<string>();
  receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; logs: Log[] }>();
  mempool = new Set<string>();
  sent: { nonce: number; gasPrice: bigint; kind: "execute" | "cancel" }[] = [];
  simError: string | null = null;
  rpcDown = false;
  private n = 0;
  async usedTradeId(_v: Address, id: Hex) { return this.used.has(id); }
  async simulate() { return this.simError ? { ok: false as const, error: this.simError } : { ok: true as const }; }
  async send(_v: Address, _p: Hex, _permit: PermitJson, _s: Hex[], nonce: number, gasPrice: bigint) {
    const h = tid(0xabc000 + ++this.n);
    this.sent.push({ nonce, gasPrice, kind: "execute" });
    this.mempool.add(h);
    this.pending = Math.max(this.pending, nonce + 1);
    return h;
  }
  async sendCancel(nonce: number, gasPrice: bigint) {
    const h = tid(0xcc0000 + ++this.n);
    this.sent.push({ nonce, gasPrice, kind: "cancel" });
    return h;
  }
  async nonce(tag: "latest" | "pending") { if (this.rpcDown) throw new Error("ECONNREFUSED"); return tag === "latest" ? this.latest : this.pending; }
  async gasPrice() { return 500_000_000_000n; }
  async receipt(h: Hex) { return this.receipts.get(h) ?? null; }
  async txExists(h: Hex) { return this.mempool.has(h); }
  async fillLogs(_v: Address, id: Hex) { return { logs: [fillLog(id, 5_000_000n, 82_000n, 0n)], txHash: tid(0xfeed), blockNumber: 101n }; }
  async pause() { return tid(0x9a05e); }
  async stopOut() { return tid(0x5709); }
  async checkBreaker() { return tid(0xb4ea); }
  async tighten() { return tid(0x7167); }
  mine(hash: Hex, tradeId: Hex, status: "success" | "reverted" = "success") {
    this.receipts.set(hash, { status, blockNumber: 100n, gasUsed: 250_000n, effectiveGasPrice: 500_000_000_000n, logs: status === "success" ? [fillLog(tradeId, 5_000_000n, 82_000n, 0n)] : [] });
    if (status === "success") this.used.add(tradeId);
    this.mempool.delete(hash);
    this.latest++;
  }
}

function meta(n: number, deadline = Math.floor(NOW / 1000) + 120): TxMeta {
  const permit: PermitJson = { tradeId: tid(n), tier: 2, pathHash: Z, amountIn: "5000000", minOut: "80000", refAmountOut: "81000", expectedNetValue: "15000", predictionHash: Z, decisionHash: Z, policyHash: Z, deadline };
  return { vault: VAULT, proposalId: `p-${n}`, asset: "WBTC", side: "BUY", tier: "B", path: "0x" as Hex, permit, signatures: ["0x" as Hex], predictionHash: null };
}

function setup() {
  let clock = NOW;
  const chain = new FakeChain();
  const store = new Store(":memory:");
  const tx = new TxManager(chain, store, undefined, () => clock);
  return { chain, store, tx, advance: (s: number) => (clock += s * 1000), now: () => clock };
}

describe("Transaction manager (Stages 13–14)", () => {
  it("submit → mined → CONFIRMED, fill recorded from the vault event", async () => {
    const { chain, store, tx } = setup();
    const s = await tx.submit(meta(1));
    expect(s.status).toBe("SUBMITTED");
    if (s.status !== "SUBMITTED") return;
    expect(s.nonce).toBe(10);
    chain.mine(s.hash, tid(1));
    const r = await tx.reconcile();
    expect(r[0]!.to).toBe("CONFIRMED");
    expect(store.trades()[0]!.amount_out).toBe("82000");
    expect(store.trades()[0]!.expected_net).toBe("15000");
  });

  it("Scenario 4 — a duplicate submission of the same trade is blocked before sending", async () => {
    const { chain, tx, store } = setup();
    await tx.submit(meta(2));
    const again = await tx.submit(meta(2));
    expect(again.status).toBe("DUPLICATE_BLOCKED");
    expect(chain.sent).toHaveLength(1);
    expect(store.txEvents(tid(2)).map((e) => e.event)).toContain("DUPLICATE_BLOCKED");
  });

  it("refuses a tradeId the vault already consumed; never sends when simulation fails", async () => {
    const { chain, tx } = setup();
    chain.used.add(tid(3));
    expect((await tx.submit(meta(3))).status).toBe("ALREADY_EXECUTED");
    chain.simError = "Cooldown";
    const s = await tx.submit(meta(4));
    expect(s.status).toBe("SIMULATION_FAILED");
    expect(chain.sent).toHaveLength(0);
  });

  it("allocates sequential nonces", async () => {
    const { chain, tx } = setup();
    await tx.submit(meta(5));
    await tx.submit(meta(6));
    expect(chain.sent.map((x) => x.nonce)).toEqual([10, 11]);
  });

  it("a reverted receipt becomes REVERTED (and is not recorded as a fill)", async () => {
    const { chain, store, tx } = setup();
    const s = await tx.submit(meta(7));
    if (s.status !== "SUBMITTED") throw new Error();
    chain.mine(s.hash, tid(7), "reverted");
    expect((await tx.reconcile())[0]!.to).toBe("REVERTED");
    expect(store.trades()).toHaveLength(0);
  });

  it("nonce consumed by another tx: CONFIRMED if the vault shows the trade executed, else REPLACED", async () => {
    const { chain, store, tx } = setup();
    const a = await tx.submit(meta(8));
    const b = await tx.submit(meta(9));
    if (a.status !== "SUBMITTED" || b.status !== "SUBMITTED") throw new Error();
    chain.latest = 12; // both nonces consumed, no receipts for our hashes
    chain.used.add(tid(8)); // trade 8 executed via a replacement; trade 9 did not
    const r = await tx.reconcile();
    expect(r.find((x) => x.tradeId === tid(8))!.to).toBe("CONFIRMED");
    expect(r.find((x) => x.tradeId === tid(9))!.to).toBe("REPLACED");
    expect(store.trades().map((t) => t.tx_hash)).toEqual([tid(0xfeed)]);
  });

  it("a dropped tx is resubmitted ONCE with the same permit and nonce and higher gas, then DROPPED", async () => {
    const { chain, store, tx, advance } = setup();
    const s = await tx.submit(meta(10, Math.floor(NOW / 1000) + 600));
    if (s.status !== "SUBMITTED") throw new Error();
    chain.mempool.clear();
    advance(61);
    const r1 = await tx.reconcile();
    expect(r1[0]!.to).toBe("SUBMITTED");
    expect(chain.sent[1]).toEqual({ nonce: 10, gasPrice: 625_000_000_000n, kind: "execute" });
    chain.mempool.clear();
    advance(61);
    expect((await tx.reconcile())[0]!.to).toBe("DROPPED");
    expect(store.txGet(tid(10))!.attempts).toBe(2);
  });

  it("a tx stuck past its permit deadline is cancelled at the same nonce, then CANCELLED", async () => {
    const { chain, tx, advance } = setup();
    const s = await tx.submit(meta(11));
    if (s.status !== "SUBMITTED") throw new Error();
    advance(200); // deadline 120s + 30s grace passed, still in mempool
    const r = await tx.reconcile();
    expect(r[0]!.note).toMatch(/cancel sent/);
    expect(chain.sent.at(-1)!.kind).toBe("cancel");
    chain.latest = 11; // the cancel mined
    expect((await tx.reconcile())[0]!.to).toBe("CANCELLED");
  });

  it("Scenario 9 — RPC down: nothing changes state", async () => {
    const { chain, store, tx } = setup();
    const s = await tx.submit(meta(12));
    if (s.status !== "SUBMITTED") throw new Error();
    chain.rpcDown = true;
    expect(await tx.reconcile()).toEqual([]);
    expect(store.txGet(tid(12))!.status).toBe("SUBMITTED");
    expect(store.txEvents(tid(12)).map((e) => e.event)).toContain("RECONCILE_DEFERRED");
  });

  it("settle() polls until a terminal state", async () => {
    const { chain, tx } = setup();
    const s = await tx.submit(meta(13));
    if (s.status !== "SUBMITTED") throw new Error();
    setTimeout(() => chain.mine(s.hash, tid(13)), 20);
    const row = await tx.settle(tid(13), 2_000, 10);
    expect(row!.status).toBe("CONFIRMED");
  });
});

describe("Positions and exits (Stage 16)", () => {
  const wethHealth = (spot: number) =>
    evaluateMarket(snap({ pools: [pool({ spot, twapShort: spot, twapLong: spot })], references: [cex("gate", spot), cex("mexc", spot + 1)] }), ["WETH"], { now: NOW });
  const held = () => {
    const v = paperVaultState(MAINNET, 5);
    const w = v.positions.find((p) => p.asset === "WETH")!;
    w.qty = 3n * 10n ** 15n; // 0.003 WETH
    w.cost = 5_100_000n; // bought at 1700
    return v;
  };
  const pred = (o: Partial<PredictionRow> = {}): PredictionRow => ({ hash: "0xp", trade_id: "0xt", asset: "WETH", direction: "BUY", entry: 1700, target: 1720, invalidation: 1680, probability: 0.6, expires_at: Math.floor(NOW / 1000) + 3600, created_at: Math.floor(NOW / 1000) - 60, payload: "{}", outcome: null, resolved_at: null, resolved_price: null, ...o });
  const nowSec = Math.floor(NOW / 1000);

  it("marks at the executable exit (fee + impact), no exit inside the levels", () => {
    const [p] = evaluatePositions(MAINNET, held(), wethHealth(1705), [pred()], nowSec);
    expect(p!.exitValueUsdt).toBeLessThan(0.003 * 1705);
    expect(p!.exit).toBeNull();
  });
  it("take-profit, invalidation and expiry", () => {
    expect(evaluatePositions(MAINNET, held(), wethHealth(1725), [pred()], nowSec)[0]!.exit!.reason).toBe("TAKE_PROFIT");
    expect(evaluatePositions(MAINNET, held(), wethHealth(1679), [pred()], nowSec)[0]!.exit!.reason).toBe("INVALIDATED");
    expect(evaluatePositions(MAINNET, held(), wethHealth(1705), [pred({ expires_at: nowSec - 1 })], nowSec)[0]!.exit!.reason).toBe("EXPIRED");
  });
  it("hard stop-loss on cost basis applies even without a prediction", () => {
    const [p] = evaluatePositions(MAINNET, held(), wethHealth(1640), [], nowSec);
    expect(p!.exit!.reason).toBe("STOP_LOSS");
  });
  it("no exits on REJECTed market data (never sell into bad data)", () => {
    const bad = evaluateMarket(snap({ head: null, pools: [] }), ["WETH"], { now: NOW });
    expect(evaluatePositions(MAINNET, held(), bad, [pred()], nowSec)[0]!.exit).toBeNull();
  });
  it("grades predictions: HIT / INVALIDATED / EXPIRED", () => {
    expect(gradePredictions([pred()], wethHealth(1721), nowSec)[0]!.outcome).toBe("HIT");
    expect(gradePredictions([pred()], wethHealth(1679), nowSec)[0]!.outcome).toBe("INVALIDATED");
    expect(gradePredictions([pred({ expires_at: nowSec - 1 })], wethHealth(1705), nowSec)[0]!.outcome).toBe("EXPIRED");
    expect(gradePredictions([pred()], wethHealth(1705), nowSec)).toEqual([]);
  });
  it("store: a resolved prediction can never be re-graded", () => {
    const s = new Store(":memory:");
    s.recordPrediction({ hash: "0xh", tradeId: null, asset: "WETH", direction: "BUY", entry: 1, target: 2, invalidation: 0.5, probability: 0.6, expiresAt: 9, createdAt: 1, payload: {} });
    s.resolvePrediction("0xh", "HIT", 2);
    s.resolvePrediction("0xh", "INVALIDATED", 0.4);
    expect(s.predictions()[0]!.outcome).toBe("HIT");
  });
});

describe("Strategy health & circuit breaker (Stages 17–18)", () => {
  const trade = (side: string, pnl: number, o: Partial<TradeRow> = {}): TradeRow => ({ trade_id: Math.random().toString(), at: 0, asset: "WETH", side, tier: "B", amount_in: "1", amount_out: "1", realized_pnl: String(Math.round(pnl * 1e6)), expected_net: "10000", gas_used: "250000", gas_price: "500000000000", tx_hash: "0x", block: 1, prediction_hash: null, ...o });
  const pr = (p: number, outcome: string | null): PredictionRow => ({ hash: Math.random().toString(), trade_id: null, asset: "WETH", direction: "BUY", entry: 1, target: 2, invalidation: 0.5, probability: p, expires_at: 0, created_at: 0, payload: "{}", outcome, resolved_at: 0, resolved_price: 0 });
  const tx = (status: string) => ({ status }) as TxRow;

  it("win rate, gas-inclusive net P&L, drawdown, Brier kept separate from P&L", () => {
    const m = computeMetrics([trade("BUY", 0), trade("SELL", 0.05), trade("BUY", 0), trade("SELL", -0.02)], [pr(0.7, "HIT"), pr(0.7, "INVALIDATED")], [tx("CONFIRMED"), tx("REVERTED")], 0.08);
    expect(m.closedTrades).toBe(2);
    expect(m.winRatePct).toBe(50);
    expect(m.realizedPnlUsdt).toBeCloseTo(0.03);
    expect(m.gasUsdt).toBeCloseTo(4 * 0.01);
    expect(m.netPnlUsdt).toBeCloseTo(0.03 - 0.04);
    expect(m.predictions.brier).toBeCloseTo((0.09 + 0.49) / 2);
    expect(m.tx.failureRatePct).toBe(50);
    expect(m.maxDrawdownUsdt).toBeGreaterThan(0);
  });
  it("Scenario 7 — consecutive losses / drawdown / failures pause; bad calibration drops tier C", () => {
    const losing = computeMetrics([trade("SELL", -0.1), trade("SELL", -0.1), trade("SELL", -0.1)], [], [], 0.08);
    expect(circuitBreaker(losing).map((a) => a.kind)).toContain("PAUSE");
    const failing = computeMetrics([], [], ["FAILED", "REVERTED", "CONFIRMED", "DROPPED"].map(tx), 0.08);
    expect(circuitBreaker(failing)[0]!.reason).toMatch(/failure rate/);
    const overconfident = computeMetrics([], Array.from({ length: 8 }, () => pr(0.9, "INVALIDATED")), [], 0.08);
    expect(circuitBreaker(overconfident).map((a) => a.kind)).toEqual(["DISABLE_TIER_C"]);
    expect(circuitBreaker(computeMetrics([trade("SELL", 0.1)], [], [], 0.08))).toEqual([]);
  });
});
