import { z } from "zod";

export const AssetZ = z.enum(["WHSK", "WETH", "WBTC"]);
const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** What the agent sends. The Guardian re-derives every price; only intent is taken from here. */
export const ProposalZ = z.object({
  proposalId: z.string().min(4).max(80),
  vault: Address.nullable(),
  tier: z.enum(["EXIT", "A", "B", "C"]),
  asset: AssetZ,
  side: z.enum(["BUY", "SELL"]),
  amountIn: z.string().regex(/^\d+$/), // raw units of tokenIn
  prediction: z.record(z.string(), z.unknown()).nullable(),
  predictionHash: Hex.nullable(),
  strategist: z
    .object({ source: z.enum(["llm", "rules"]), probability: z.number(), target: z.number(), invalidation: z.number() })
    .nullable(),
  candidateId: z.string().nullable(),
});
export type Proposal = z.infer<typeof ProposalZ>;

export type Decision = "APPROVE" | "REJECT" | "WAIT";

export interface Check {
  name: string;
  pass: boolean;
  severity: "hard" | "soft"; // hard fail => REJECT, soft fail => WAIT
  value?: string | number | null;
  limit?: string | number | null;
  note?: string;
}

export interface ExecutionPlanLeg {
  index: number;
  amountIn: string;
  minOut: string;
  notBefore: number; // unix seconds (cooldown spacing)
}

export interface ExecutionPlan {
  method: "IMMEDIATE" | "SPLIT" | "WAIT";
  legs: ExecutionPlanLeg[];
  comparison: { legs: number; outPerLeg: string; totalOut: string; extraGasUsdt: number; netVsSingleUsdt: number }[];
  reason: string;
}

export interface PermitJson {
  tradeId: `0x${string}`;
  tier: number;
  pathHash: `0x${string}`;
  amountIn: string;
  minOut: string;
  refAmountOut: string;
  expectedNetValue: string;
  predictionHash: `0x${string}`;
  decisionHash: `0x${string}`;
  policyHash: `0x${string}`;
  deadline: number;
}

export interface GuardianResponse {
  decision: Decision;
  proposalId: string;
  evaluatedAt: number;
  guardian: string;
  dryRun: boolean;
  reasons: string[];
  checks: Check[];
  economics: {
    amountInUsdt: number;
    quotedOut: string;
    minOut: string;
    twapFloor: string;
    refAmountOut: string;
    referencePrice: number | null;
    dexSpot: number;
    impactBps: number | null;
    edgeBps: number | null;
    gasUsdt: number;
    exitCostUsdt: number;
    expectedNetValueUsdt: number;
  } | null;
  plan: ExecutionPlan | null;
  path: `0x${string}` | null;
  permit: PermitJson | null;
  signature: `0x${string}` | null;
  simulation: { ok: boolean; error?: string } | null;
  decisionHash: `0x${string}` | null;
}
