import { keccak256, toBytes } from "viem";

/**
 * Sworn Prediction (Stage 8). The prediction is serialized canonically (sorted keys, no
 * whitespace) and hashed; the hash is bound into the Guardian's permit and emitted on-chain in
 * TradeExecuted, so the original claim can later be checked against what actually happened.
 */
export interface Prediction {
  version: 1;
  agentId: string;
  strategyId: string;
  vault: string | null;
  chainId: number;
  asset: string;
  direction: "BUY" | "SELL";
  entryRef: number;
  target: number;
  invalidation: number;
  probability: number;
  expiresAt: number; // unix seconds
  createdAt: number; // unix seconds
  candidateId: string;
  statement: string;
}

export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") {
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error("non-finite number in prediction");
    return JSON.stringify(x);
  }
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function hashPrediction(p: Prediction): `0x${string}` {
  return keccak256(toBytes(canonicalJson(p)));
}

export function statement(p: Omit<Prediction, "statement">): string {
  const dir = p.direction === "BUY" ? "rise toward" : "fall toward";
  return `${p.agentId} predicts ${p.asset} on HSKSwap will ${dir} ${p.target.toPrecision(6)} before ${new Date(
    p.expiresAt * 1000,
  ).toISOString()}; invalid if it crosses ${p.invalidation.toPrecision(6)}. Probability ${(p.probability * 100).toFixed(0)}%.`;
}

export function makePrediction(p: Omit<Prediction, "statement" | "version">): { prediction: Prediction; hash: `0x${string}` } {
  const base = { version: 1 as const, ...p };
  const prediction: Prediction = { ...base, statement: statement(base) };
  return { prediction, hash: hashPrediction(prediction) };
}
