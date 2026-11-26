import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { countersignVaultAbi } from "../../abi/countersignVault.js";
import { hskChain } from "../../common/chain.js";
import type { Store, TxRow } from "../../common/store.js";
import type { NetworkConfig } from "../../config.js";
import { toMessage } from "../../guardian/permit.js";
import type { PermitJson } from "../../guardian/types.js";

/** Everything the manager needs from the chain — real (viem) or fake (tests). */
export interface ChainOps {
  agent: Address;
  usedTradeId(vault: Address, tradeId: Hex): Promise<boolean>;
  simulate(vault: Address, path: Hex, permit: PermitJson, sigs: Hex[]): Promise<{ ok: true } | { ok: false; error: string }>;
  send(vault: Address, path: Hex, permit: PermitJson, sigs: Hex[], nonce: number, gasPrice: bigint): Promise<Hex>;
  sendCancel(nonce: number, gasPrice: bigint): Promise<Hex>;
  nonce(tag: "latest" | "pending"): Promise<number>;
  gasPrice(): Promise<bigint>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; logs: Log[] } | null>;
  txExists(hash: Hex): Promise<boolean>;
  fillLogs(vault: Address, tradeId: Hex): Promise<{ logs: Log[]; txHash: Hex; blockNumber: bigint } | null>;
  /** Circuit breaker: the agent may only restrict itself (the vault rejects anything looser). */
  pause(vault: Address): Promise<Hex>;
  tighten(vault: Address, mandate: import("../vault/state.js").Mandate): Promise<Hex>;
  /** v2 keeper actions — permissionless on the vault; the agent key only pays the gas. */
  stopOut(vault: Address, asset: Address, amountIn: bigint): Promise<Hex>;
  checkBreaker(vault: Address): Promise<Hex>;
  anchorDecisions(vault: Address, root: Hex, fromSeq: bigint, toSeq: bigint): Promise<Hex>;
}

export type SubmitOutcome =
  | { status: "SUBMITTED"; hash: Hex; nonce: number }
  | { status: "DUPLICATE_BLOCKED"; reason: string }
  | { status: "ALREADY_EXECUTED"; reason: string }
  | { status: "SIMULATION_FAILED"; reason: string }
  | { status: "SEND_FAILED"; reason: string };

export interface TxMeta {
  vault: Address;
  proposalId: string;
  asset: string;
  side: string;
  tier: string;
  path: Hex;
  permit: PermitJson;
  signatures: Hex[]; // committee signatures, sorted by signer address
  predictionHash: string | null;
}

export interface ReconcileReport {
  tradeId: string;
  from: string;
  to: string;
  note: string;
}

export interface TxPolicy {
  dropAfterSec: number; // not found in mempool for this long => DROPPED
  cancelAfterDeadlineSec: number; // permit expired + this => send a cancel at the same nonce
  gasBumpPct: number; // replacement gas premium
  maxResubmits: number;
}
export const DEFAULT_TX_POLICY: TxPolicy = { dropAfterSec: 60, cancelAfterDeadlineSec: 30, gasBumpPct: 25, maxResubmits: 1 };

/**
 * Transaction Monitoring (Stage 13) + Smart Trade Recovery (Stage 14).
 * Safety model: a tradeId executes at most once — enforced by the vault (usedTradeIds) — and
 * this manager never re-sends anything before reconciling chain state first.
 */
export class TxManager {
  private nextNonce: number | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ops: ChainOps,
    private readonly store: Store,
    private readonly policy: TxPolicy = DEFAULT_TX_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async allocNonce(): Promise<number> {
    const chain = await this.ops.nonce("pending");
    const n = this.nextNonce === null ? chain : Math.max(chain, this.nextNonce);
    this.nextNonce = n + 1;
    return n;
  }

  /** Scenario 4 — duplicate submissions are blocked locally AND on-chain before anything is sent. */
  submit(m: TxMeta): Promise<SubmitOutcome> {
    return this.serial(async () => {
      const id = m.permit.tradeId;
      const existing = this.store.txGet(id);
      if (existing && ["SUBMITTED", "PENDING", "CONFIRMED"].includes(existing.status)) {
        this.store.txEvent(id, "DUPLICATE_BLOCKED", { existing: existing.status, hash: existing.hash });
        return { status: "DUPLICATE_BLOCKED", reason: `trade ${id.slice(0, 10)} already ${existing.status} (${existing.hash})` };
      }
      if (await this.ops.usedTradeId(m.vault, id)) {
        this.store.txEvent(id, "ALREADY_EXECUTED", {});
        return { status: "ALREADY_EXECUTED", reason: "the vault has already consumed this tradeId" };
      }
      const sim = await this.ops.simulate(m.vault, m.path, m.permit, m.signatures);
      if (!sim.ok) {
        this.store.txEvent(id, "SIMULATION_FAILED", { error: sim.error });
        return { status: "SIMULATION_FAILED", reason: sim.error };
      }
      const nonce = await this.allocNonce();
      try {
        const gasPrice = await this.ops.gasPrice();
        const hash = await this.ops.send(m.vault, m.path, m.permit, m.signatures, nonce, gasPrice);
        this.store.txUpsert({ tradeId: id, proposalId: m.proposalId, asset: m.asset, side: m.side, tier: m.tier, hash, nonce, status: "SUBMITTED", deadline: m.permit.deadline, payload: { ...m, gasPrice }, at: this.now() });
        return { status: "SUBMITTED", hash, nonce };
      } catch (e) {
        this.nextNonce = null; // re-read from chain next time
        const reason = (e as Error).message.split("\n")[0]!;
        this.store.txEvent(id, "SEND_FAILED", { reason });
        return { status: "SEND_FAILED", reason };
      }
    });
  }

  /** Called every tick. Moves each active tx to a terminal state using chain facts only. */
  reconcile(): Promise<ReconcileReport[]> {
    return this.serial(async () => {
      const reports: ReconcileReport[] = [];
      const nowMs = this.now();
      let latest: number;
      try {
        latest = await this.ops.nonce("latest");
      } catch (e) {
        // Scenario 9: without chain state we change nothing.
        for (const t of this.store.txActive()) this.store.txEvent(t.trade_id, "RECONCILE_DEFERRED", { reason: (e as Error).message.split("\n")[0] });
        return [];
      }
      for (const t of this.store.txActive()) {
        try {
          const r = await this.reconcileOne(t, latest, nowMs);
          if (r) reports.push(r);
        } catch (e) {
          this.store.txEvent(t.trade_id, "RECONCILE_ERROR", { reason: (e as Error).message.split("\n")[0] });
        }
      }
      return reports;
    });
  }

  private record(t: TxRow, rc: { blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; logs: Log[] }, txHash: string) {
    const ev = parseEventLogs({ abi: countersignVaultAbi, eventName: "TradeExecuted", logs: rc.logs })[0];
    const a = ev?.args as { amountIn: bigint; amountOut: bigint; realizedPnl: bigint; expectedNetValue: bigint; predictionHash: Hex } | undefined;
    if (!a) return;
    this.store.recordTrade({
      tradeId: t.trade_id,
      at: this.now(),
      asset: t.asset,
      side: t.side,
      tier: t.tier,
      amountIn: a.amountIn.toString(),
      amountOut: a.amountOut.toString(),
      realizedPnl: a.realizedPnl.toString(),
      expectedNet: a.expectedNetValue.toString(),
      gasUsed: rc.gasUsed.toString(),
      gasPrice: rc.effectiveGasPrice.toString(),
      txHash,
      block: Number(rc.blockNumber),
      predictionHash: a.predictionHash,
    });
  }

  private async reconcileOne(t: TxRow, latestNonce: number, nowMs: number): Promise<ReconcileReport | null> {
    const hash = t.hash as Hex;
    const meta = JSON.parse(t.payload) as TxMeta & { gasPrice: string; cancelHash?: Hex };
    const rc = await this.ops.receipt(hash);
    if (rc) {
      const to = rc.status === "success" ? "CONFIRMED" : "REVERTED";
      if (to === "CONFIRMED") this.record(t, rc, hash);
      this.store.txSetStatus(t.trade_id, to, { block: rc.blockNumber, gasUsed: rc.gasUsed });
      return { tradeId: t.trade_id, from: t.status, to, note: `mined in block ${rc.blockNumber}` };
    }

    if (t.nonce !== null && latestNonce > t.nonce) {
      // Our nonce was consumed by a different transaction. Did the trade still execute?
      if (await this.ops.usedTradeId(meta.vault, t.trade_id as Hex)) {
        const fill = await this.ops.fillLogs(meta.vault, t.trade_id as Hex);
        if (fill) this.record(t, { ...fill, gasUsed: 0n, effectiveGasPrice: 0n }, fill.txHash);
        this.store.txSetStatus(t.trade_id, "CONFIRMED", { via: fill?.txHash ?? "replacement", reconciled: true });
        return { tradeId: t.trade_id, from: t.status, to: "CONFIRMED", note: "executed by a replacement transaction (reconciled on-chain)" };
      }
      const to = meta.cancelHash ? "CANCELLED" : "REPLACED";
      this.store.txSetStatus(t.trade_id, to, { latestNonce });
      return { tradeId: t.trade_id, from: t.status, to, note: "nonce consumed without executing the trade; safe to re-propose" };
    }

    const ageSec = (nowMs - t.submitted_at) / 1000;
    const inMempool = await this.ops.txExists(hash);
    const nowSec = Math.floor(nowMs / 1000);
    if (!inMempool && ageSec > this.policy.dropAfterSec) {
      // Dropped: nothing will mine. Resubmitting the SAME permit at the SAME nonce is safe (single tradeId).
      if (t.attempts <= this.policy.maxResubmits && nowSec < t.deadline - 15) {
        const gasPrice = (BigInt(meta.gasPrice) * BigInt(100 + this.policy.gasBumpPct)) / 100n;
        const newHash = await this.ops.send(meta.vault, meta.path, meta.permit, meta.signatures, t.nonce!, gasPrice);
        this.store.txUpsert({ tradeId: t.trade_id, proposalId: t.proposal_id, asset: t.asset, side: t.side, tier: t.tier, hash: newHash, nonce: t.nonce, status: "SUBMITTED", deadline: t.deadline, payload: { ...meta, gasPrice }, at: this.now() });
        return { tradeId: t.trade_id, from: t.status, to: "SUBMITTED", note: `dropped; resubmitted same permit at nonce ${t.nonce} with +${this.policy.gasBumpPct}% gas` };
      }
      this.nextNonce = null;
      this.store.txSetStatus(t.trade_id, "DROPPED", { ageSec });
      return { tradeId: t.trade_id, from: t.status, to: "DROPPED", note: "not in mempool; permit too close to expiry to retry" };
    }

    if (inMempool && nowSec > t.deadline + this.policy.cancelAfterDeadlineSec && !meta.cancelHash) {
      // The permit has expired: if mined it can only revert. Free the nonce with a 0-value self-transfer.
      const gasPrice = (BigInt(meta.gasPrice) * BigInt(100 + this.policy.gasBumpPct)) / 100n;
      const cancelHash = await this.ops.sendCancel(t.nonce!, gasPrice);
      this.store.txUpsert({ tradeId: t.trade_id, proposalId: t.proposal_id, asset: t.asset, side: t.side, tier: t.tier, hash, nonce: t.nonce, status: "PENDING", deadline: t.deadline, payload: { ...meta, cancelHash }, at: this.now() });
      return { tradeId: t.trade_id, from: t.status, to: "PENDING", note: `permit expired while pending; cancel sent (${cancelHash})` };
    }

    if (t.status === "SUBMITTED" && inMempool) {
      this.store.txSetStatus(t.trade_id, "PENDING", { ageSec });
      return { tradeId: t.trade_id, from: "SUBMITTED", to: "PENDING", note: "seen in mempool" };
    }
    return null;
  }

  /** Waits (bounded) for a submitted trade to reach a terminal state. */
  async settle(tradeId: string, timeoutMs = 90_000, pollMs = 3_000): Promise<TxRow | null> {
    const end = this.now() + timeoutMs;
    for (;;) {
      await this.reconcile();
      const t = this.store.txGet(tradeId);
      if (!t || !["SUBMITTED", "PENDING"].includes(t.status) || this.now() > end) return t;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/** Real chain implementation (viem). Legacy gas pricing: HSK Chain quotes a flat ~500 gwei. */
export function viemChainOps(client: PublicClient, net: NetworkConfig, agentPk: Hex): ChainOps {
  const account = privateKeyToAccount(agentPk);
  const wallet = createWalletClient({ account, chain: hskChain(net), transport: http(net.rpcUrls[0]) });
  return {
    agent: account.address,
    usedTradeId: (vault, id) => client.readContract({ address: vault, abi: countersignVaultAbi, functionName: "usedTradeIds", args: [id] }) as Promise<boolean>,
    async simulate(vault, path, permit, sigs) {
      try {
        await client.simulateContract({ address: vault, abi: countersignVaultAbi, functionName: "execute", args: [path, toMessage(permit), sigs], account });
        return { ok: true };
      } catch (e) {
        let name = (e as Error).message.split("\n")[0]!;
        if (e instanceof BaseError) {
          const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
          if (r instanceof ContractFunctionRevertedError) name = r.data?.errorName ?? r.reason ?? name;
        }
        return { ok: false, error: name };
      }
    },
    send: (vault, path, permit, sigs, nonce, gasPrice) =>
      wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "execute", args: [path, toMessage(permit), sigs], nonce, gasPrice, gas: 600_000n, type: "legacy" }),
    stopOut: (vault, asset, amountIn) =>
      wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "stopOut", args: [asset, amountIn, 0n], gas: 600_000n, type: "legacy" }),
    anchorDecisions: (vault, root, fromSeq, toSeq) =>
      wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "anchorDecisions", args: [root, fromSeq, toSeq], gas: 200_000n, type: "legacy" }),
    checkBreaker: (vault) => wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "checkBreaker", gas: 300_000n, type: "legacy" }),
    sendCancel: (nonce, gasPrice) => wallet.sendTransaction({ to: account.address, value: 0n, nonce, gasPrice, gas: 21_000n, type: "legacy" }),
    nonce: (tag) => client.getTransactionCount({ address: account.address, blockTag: tag }),
    gasPrice: () => client.getGasPrice(),
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, logs: r.logs };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    async txExists(hash) {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
    pause: (vault) => wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "pause", type: "legacy" }),
    tighten: (vault, m) => wallet.writeContract({ address: vault, abi: countersignVaultAbi, functionName: "tighten", args: [m as never], type: "legacy" }),
    async fillLogs(vault, tradeId) {
      const head = await client.getBlockNumber();
      const logs = await client.getContractEvents({ address: vault, abi: countersignVaultAbi, eventName: "TradeExecuted", args: { tradeId }, fromBlock: head > 5_000n ? head - 5_000n : 0n, toBlock: head });
      const l = logs[0];
      return l ? { logs: [l as unknown as Log], txHash: l.transactionHash!, blockNumber: l.blockNumber! } : null;
    },
  };
}
