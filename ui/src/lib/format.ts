const ok = (x: unknown): x is number => x !== null && x !== undefined && Number.isFinite(Number(x));

export const num = (x: unknown, d = 4) => (ok(x) ? Number(x).toFixed(d) : "—");
export const sig = (x: unknown, d = 6) => (ok(x) ? Number(x).toPrecision(d) : "—");
export const bps = (x: unknown) => (ok(x) ? `${Number(x) >= 0 ? "+" : ""}${Math.round(Number(x))} bps` : "—");
export const usd = (x: unknown, d = 2) => (ok(x) ? `$${Number(x).toFixed(d)}` : "—");
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export function ago(t?: number | null) {
  if (!t) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s.toFixed(0)}s ago` : s < 3600 ? `${(s / 60).toFixed(0)}m ago` : s < 86400 ? `${(s / 3600).toFixed(1)}h ago` : `${(s / 86400).toFixed(1)}d ago`;
}
