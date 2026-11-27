import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetOwnerRequests,
  amountForPercent,
  enqueueOwnerRequest,
  finishOwnerRequest,
  listOwnerRequests,
  takeOwnerRequest,
} from "../src/modules/owner/requests.js";

describe("owner rebalance requests", () => {
  beforeEach(() => _resetOwnerRequests());

  it("converts a percent of the tracked position, rounding down, never above it", () => {
    const qty = 76n * 10n ** 18n;
    expect(amountForPercent(qty, 100)).toBe(qty);
    expect(amountForPercent(qty, 50)).toBe(38n * 10n ** 18n);
    expect(amountForPercent(qty, 92.5)).toBe((qty * 9250n) / 10_000n);
    expect(amountForPercent(qty, 250)).toBe(qty); // clamped
    expect(amountForPercent(qty, -5)).toBe(0n);
  });

  it("queues one request at a time and walks QUEUED → RUNNING → EXECUTED", () => {
    const r = enqueueOwnerRequest({ asset: "WHSK", percent: 90, requestedBy: "0xowner" }, 1000);
    expect(r.status).toBe("QUEUED");
    expect(() => enqueueOwnerRequest({ asset: "WHSK", percent: 10, requestedBy: "0xowner" })).toThrow(/already in progress/);
    const t = takeOwnerRequest()!;
    expect(t.id).toBe(r.id);
    expect(t.status).toBe("RUNNING");
    expect(takeOwnerRequest()).toBeNull();
    expect(() => enqueueOwnerRequest({ asset: "WHSK", percent: 10, requestedBy: "0xowner" })).toThrow(/already in progress/);
    finishOwnerRequest(r.id, true, "COMMITTEE APPROVE", "0xabc");
    const [done] = listOwnerRequests();
    expect(done).toMatchObject({ status: "EXECUTED", txHash: "0xabc" });
    // a finished request frees the queue
    expect(enqueueOwnerRequest({ asset: "WHSK", percent: 10, requestedBy: "0xowner" }, 2000).status).toBe("QUEUED");
  });

  it("records a refused request without a tx hash", () => {
    const r = enqueueOwnerRequest({ asset: "WETH", percent: 100, requestedBy: "0xowner" });
    takeOwnerRequest();
    finishOwnerRequest(r.id, false, "Risk Officer REJECT", "0xshould-not-keep");
    expect(listOwnerRequests()[0]).toMatchObject({ status: "NOT_EXECUTED", txHash: null });
  });
});
