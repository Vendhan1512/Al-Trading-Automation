import { describe, expect, it } from "vitest";
import { Store } from "../src/common/store.js";
import { buildRecord, checkName } from "../src/modules/evidence/record.js";

const dec = (s: Store, kind: string, asset: string | null, outcome: string, payload: unknown, summary = `${kind} ${outcome}`) =>
  s.recordDecision({ at: Date.now(), kind, asset, outcome, summary, payload, hash: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}` });

describe("track record + refusal ledger", () => {
  it("extracts the check name from a Guardian reason", () => {
    expect(checkName("concentration (100 vs 70): WHSK share of vault value after the trade (%)")).toBe("concentration");
    expect(checkName("expected-net-value (-0.02 vs 0): after fees")).toBe("expected-net-value");
    expect(checkName("cooldown")).toBe("cooldown");
  });

  it("attributes each refusal to the party that refused it, and counts executions", () => {
    const s = new Store(":memory:");
    dec(s, "tick", null, "WAIT", {});
    dec(s, "candidate", "WBTC", "REJECT", { filter: { outcome: "PASS", reasons: [] }, guardian: { decision: "REJECT", reasons: ["expected-net-value (-0.02 vs 0): x", "total-exposure (100 vs 90): y"] } });
    dec(s, "candidate", "WBTC", "REJECT", { filter: { outcome: "PASS", reasons: [] }, guardian: { decision: "APPROVE", reasons: [] }, risk: { decision: "REJECT", reasons: ["concentration (65 vs 60): z"] } });
    dec(s, "candidate", "WHSK", "REJECT", { filter: { outcome: "REJECT", reasons: ["stale-reference: too old"] } });
    dec(s, "candidate", "WHSK", "SKIP", { filter: { outcome: "PASS", reasons: [] }, strategist: { action: "SKIP", rationale: "regime looks unstable" } });
    dec(s, "candidate", "WHSK", "WAIT", {}, "B/WHSK BUY Guardian unreachable (timeout)");
    dec(s, "owner", "WHSK", "EXECUTED", {});

    const r = buildRecord(s);
    expect(r.decisions).toMatchObject({ total: 7, ticks: 1, proposals: 6, executed: 1, approved: 1, refused: 4, waits: 1 });
    const by = Object.fromEntries(r.refusals.map((x) => [`${x.by}:${x.check}`, x.count]));
    expect(by).toEqual({
      "Execution Guardian:expected-net-value": 1,
      "Execution Guardian:total-exposure": 1,
      "Risk Officer:concentration": 1,
      "Strategy filter:stale-reference": 1,
      "Strategist:regime": 1,
    });
    expect(r.byAsset.find((a) => a.asset === "WHSK")).toMatchObject({ proposed: 4, refused: 2, executed: 1 });
    expect(r.recentRefusals[0]!.asset).toBe("WHSK"); // newest first
  });
});
