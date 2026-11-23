import type { MarketHealth } from "../data-reliability/engine.js";

const fmt = (x: number | null, d = 6) => (x === null || !Number.isFinite(x) ? "—" : x.toPrecision(d));
const sbps = (x: number | null) => (x === null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(0)} bps`);

/** Human-readable one-screen summary (CLI + logs). */
export function renderHealth(h: MarketHealth): string {
  const lines: string[] = [];
  lines.push(
    `[${new Date(h.evaluatedAt).toISOString()}] market ${h.status} · block ${h.chain.blockNumber ?? "—"} (${h.chain.blockAgeSec?.toFixed(0) ?? "—"} s old)`,
  );
  for (const a of h.assets) {
    lines.push(
      `  ${a.asset.padEnd(5)} ${a.status.padEnd(7)} dex ${fmt(a.dexSpot)}  ref ${fmt(a.reference)}  premium ${sbps(a.premiumBps)}  spot-vs-TWAP5 ${sbps(a.spotVsTwapBps)}`,
    );
    const used = a.sources.filter((s) => s.accepted).map((s) => s.source);
    const excluded = a.sources.filter((s) => !s.accepted).map((s) => `${s.source}(${s.reason})`);
    lines.push(`        sources ✓ ${used.join(", ") || "none"}${excluded.length ? `  ✗ ${excluded.join("; ")}` : ""}`);
    const imp = a.impact.map((i) => `${i.sizeUsdt}$: buy ${sbps(i.buyBps)}/sell ${sbps(i.sellBps)}`).join(" · ");
    if (imp) lines.push(`        impact ${imp}`);
    for (const f of a.findings.filter((x) => x.status !== "VALID")) lines.push(`        ${f.status}: ${f.message}`);
  }
  return lines.join("\n");
}
