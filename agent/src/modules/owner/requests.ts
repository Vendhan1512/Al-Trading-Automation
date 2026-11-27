import type { AssetSymbol } from "../../config.js";

/**
 * Owner rebalance requests: the owner (signed in with their wallet, no gas) asks the agent to
 * convert part of a position back to USDT. The request does NOT bypass anything — the agent turns
 * it into an ordinary risk-reducing EXIT proposal, which still needs BOTH committee signatures and
 * passes every vault check (TWAP floor, slippage, tracked inventory). Nobody but the vault moves funds.
 */
export interface OwnerRequest {
  id: string;
  asset: AssetSymbol;
  side: "SELL";
  percent: number; // share of the tracked position to convert, 1..100
  requestedBy: string;
  at: number;
  status: "QUEUED" | "RUNNING" | "EXECUTED" | "NOT_EXECUTED";
  result: string | null;
  txHash: string | null;
}

const MAX_KEPT = 20;
const items: OwnerRequest[] = [];

export function enqueueOwnerRequest(r: Pick<OwnerRequest, "asset" | "percent" | "requestedBy">, now = Date.now()): OwnerRequest {
  if (items.some((x) => x.status === "QUEUED" || x.status === "RUNNING")) throw new Error("a request is already in progress — wait for it to finish");
  const req: OwnerRequest = { id: `owner-${r.asset}-${now}`, asset: r.asset, side: "SELL", percent: r.percent, requestedBy: r.requestedBy, at: now, status: "QUEUED", result: null, txHash: null };
  items.unshift(req);
  items.length = Math.min(items.length, MAX_KEPT);
  return req;
}

/** Next queued request (marked RUNNING), or null. */
export function takeOwnerRequest(): OwnerRequest | null {
  const r = [...items].reverse().find((x) => x.status === "QUEUED") ?? null;
  if (r) r.status = "RUNNING";
  return r;
}

export function finishOwnerRequest(id: string, executed: boolean, result: string, txHash: string | null = null) {
  const r = items.find((x) => x.id === id);
  if (!r) return;
  r.status = executed ? "EXECUTED" : "NOT_EXECUTED";
  r.result = result;
  r.txHash = executed ? txHash : null; // only an executed trade has a tx to show
}

export function listOwnerRequests(): OwnerRequest[] {
  return items.map((x) => ({ ...x }));
}

/** Raw sell amount for `percent` of a position (rounded down; 100% = the exact tracked qty). */
export function amountForPercent(qty: bigint, percent: number): bigint {
  const p = Math.round(Math.min(100, Math.max(0, percent)) * 100); // basis points of the position
  return (qty * BigInt(p)) / 10_000n;
}

/** Test helper. */
export function _resetOwnerRequests() {
  items.length = 0;
}
