export interface Config {
  chainId: number;
  explorer: string;
  vault: string | null;
  v2Vault: string | null;
  agent: string | null;
  guardian: string | null;
  riskOfficer: string | null;
  owner: string | null;
  contracts: { vaultImplementation: string | null; vaultFactory: string | null; router: string | null };
  mode: "live" | "shadow" | string;
  copilot: string;
  publishedAt?: number;
}

export interface Position {
  asset: string;
  qty: number;
  costUsdt: number;
  avgEntry: number;
  spot: number;
  exitValueUsdt: number;
  unrealizedPnlUsdt: number;
  unrealizedPct: number;
  exit?: { reason: string } | null;
}

export interface Mandate {
  maxTradeUsdt: number; dailyVolumeUsdt: number; dailyLossUsdt: number; maxExposureUsdt: number;
  cooldownSec: number; maxSlippageBps: number; minEdgeBps: number; tiersMask: number; assetsMask: number; expiry: number;
  stopLossBps: number; takeProfitBps: number; maxDrawdownBps: number;
}

export interface Portfolio {
  vault: string | null;
  mode: "onchain" | "paper" | string;
  paused: boolean;
  usdt: number;
  totalValueUsdt: number;
  today: { volumeUsdt: number; realizedPnlUsdt: number };
  mandate: Mandate;
  committee?: { guardians: string[]; threshold: number };
  positions: Position[];
}

export interface PriceSource { source: string; mid: number; accepted: boolean }
export interface AssetPrice {
  asset: string; status: string; dexSpot: number; twap5m?: number; twap30m?: number; reference: number; premiumBps: number; sources: PriceSource[];
}
export interface Prices { evaluatedAt: number; assets: AssetPrice[] }
export interface History { points: { t: number; dex?: number; ref?: number }[] }

export interface Health {
  trades: number; closedTrades: number; wins: number; losses: number; winRatePct: number | null;
  realizedPnlUsdt: number; gasUsdt: number; netPnlUsdt: number; maxDrawdownUsdt: number; consecutiveLosses: number;
  predictions: { total: number; resolved: number; hits: number; brier: number | null; accuracyPct: number | null };
  tx: { total: number; failed: number; failureRatePct: number | null };
}

export interface Decision { seq: number; at: number; kind?: string; asset?: string | null; outcome: string; summary: string }

export interface GuardianCheck { name: string; pass: boolean; value?: unknown; limit?: unknown }
export interface DecisionDetail {
  seq: number; at: number; hash: string; outcome: string; summary: string;
  payload?: {
    candidate?: { tier: string; strategyId: string; side: string; asset: string; maxSizeUsdt: number; thesis: string; grossEdgeBps: number; entry: number; target: number; invalidation: number };
    filter?: { outcome: string; reasons: string[] };
    strategist?: { source: string; action: string; sizeUsdt: number; probability: number; rationale: string; adjustments?: string[] };
    prediction?: { statement: string };
    predictionHash?: string;
    guardian?: {
      decision: string; dryRun?: boolean; checks?: GuardianCheck[]; reasons?: string[];
      economics?: { amountInUsdt?: number; dexSpot?: number; referencePrice?: number; edgeBps?: number; impactBps?: number; gasUsdt?: number; expectedNetValueUsdt?: number };
      plan?: { method?: string; reason?: string }; permit?: { tradeId: string }; decisionHash?: string;
    };
    risk?: { decision?: string; reasons?: string[] };
    txStatus?: string;
    health?: { asset: string; status: string; premiumBps: number }[];
    cycles?: { note: string };
  };
}

export interface ArbRoute { name: string; kind: string; legs: string[]; midGapBps: number; best: { sizeUsdt: number; outUsdt: number; grossProfitUsdt: number; gasUsdt: number; netUsdt: number } | null }
export interface Arbitrage { at: number; gasPerSwapUsdt: number; venues: { name: string; priceUsdt: number; depthUsdt: number }[]; routes: ArbRoute[]; summary: string }

export interface Transactions { transactions: { trade_id: string; side: string; asset: string; tier: string; status: string; nonce: number | null; hash: string | null; updated_at: number }[] }
export interface Trades { trades: { at: number; side: string; asset: string; realized_pnl: string; expected_net: string; tx_hash: string }[] }
export interface Predictions { predictions: { hash: string; direction: string; asset: string; probability: number; target: number; invalidation: number; outcome: string | null }[] }
