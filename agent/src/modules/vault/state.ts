import { erc20Abi, type Address, type PublicClient } from "viem";
import { countersignVaultAbi } from "../../abi/countersignVault.js";
import type { AssetSymbol, NetworkConfig } from "../../config.js";
import { fromUnits } from "../../common/math.js";

/** Tiers as the vault numbers them. */
export const TIER = { EXIT: 0, A: 1, B: 2, C: 3 } as const;
export type TierName = "A" | "B" | "C";
export const tierBit = (t: TierName) => 1 << (TIER[t] - 1);

export interface Mandate {
  maxTradeQuote: bigint;
  dailyVolumeQuote: bigint;
  dailyLossQuote: bigint;
  maxExposureQuote: bigint;
  minArbProfitQuote: bigint;
  cooldown: number;
  twapWindow: number;
  maxSlippageBps: number;
  minEdgeBps: number;
  tiersMask: number;
  assetsMask: number;
  expiry: bigint;
  minNetValueQuote: bigint; // v2: entries need committee-signed expectedNetValue >= this (> 0 when 0)
  stopLossBps: number; // v2: permissionless TWAP stop-loss vs average cost (0 = off)
  takeProfitBps: number; // v2: permissionless TWAP take-profit (0 = off)
  maxDrawdownBps: number; // v2: NAV breaker vs high-water mark (0 = off)
}

export interface PositionState {
  asset: AssetSymbol;
  token: Address;
  index: number; // bit index in assetsMask
  qty: bigint; // tracked quantity (raw)
  cost: bigint; // cost basis (quote raw)
  balance: bigint; // actual token balance (raw)
  decimals: number;
  reentryBlockedUntil: number; // v2: unix seconds; buys refused until then (after a stop-loss)
}

export interface VaultState {
  mode: "onchain" | "paper";
  address: Address | null;
  chainId: number;
  owner: Address | null;
  agent: Address | null;
  guardian: Address | null; // first committee member (v1 compatibility)
  guardians: Address[];
  threshold: number;
  paused: boolean;
  breakerTripped: boolean;
  highWaterMark: bigint;
  nav: bigint | null; // quote raw, TWAP-valued (null if unavailable)
  policyHash: `0x${string}`;
  mandate: Mandate;
  quoteBalance: bigint;
  quoteDecimals: number;
  positions: PositionState[];
  dayVolume: bigint;
  dayPnl: bigint;
  lastEntryAt: number;
  readAt: number;
}

export const usdt = (raw: bigint, decimals = 6) => fromUnits(raw, decimals);

/** Reads the full vault state the strategy, filter and Guardian need. Source of truth = chain. */
export async function readVaultState(client: PublicClient, net: NetworkConfig, vault: Address): Promise<VaultState> {
  const c = { address: vault, abi: countersignVaultAbi } as const;
  const [owner, agent, guardians, threshold, paused, policyHash, mandate, assets, day, lastEntryAt, breakerTripped, highWaterMark] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "owner" },
      { ...c, functionName: "agent" },
      { ...c, functionName: "guardians" },
      { ...c, functionName: "threshold" },
      { ...c, functionName: "paused" },
      { ...c, functionName: "policyHash" },
      { ...c, functionName: "mandate" },
      { ...c, functionName: "assets" },
      { ...c, functionName: "currentDay" },
      { ...c, functionName: "lastEntryAt" },
      { ...c, functionName: "breakerTripped" },
      { ...c, functionName: "highWaterMark" },
    ],
  });
  const navRead = await client.readContract({ ...c, functionName: "nav" }).catch(() => null);
  const assetList = assets as readonly Address[];
  const posReads = await client.multicall({
    allowFailure: false,
    contracts: assetList.flatMap((a) => [
      { ...c, functionName: "positions", args: [a] } as const,
      { address: a, abi: erc20Abi, functionName: "balanceOf", args: [vault] } as const,
      { ...c, functionName: "reentryBlockedUntil", args: [a] } as const,
    ]),
  });
  const quoteBalance = await client.readContract({ address: net.quote.address, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const positions: PositionState[] = assetList.map((token, i) => {
    const pool = net.pools.find((p) => p.base.address.toLowerCase() === token.toLowerCase());
    const [qty, cost] = posReads[i * 3] as readonly [bigint, bigint];
    return {
      asset: (pool?.asset ?? "WHSK") as AssetSymbol,
      token,
      index: i,
      qty,
      cost,
      balance: posReads[i * 3 + 1] as bigint,
      decimals: pool?.base.decimals ?? 18,
      reentryBlockedUntil: Number(posReads[i * 3 + 2] as bigint),
    };
  });
  const m = mandate as unknown as Mandate;
  const [vol, pnl] = day as readonly [bigint, bigint];
  return {
    mode: "onchain",
    address: vault,
    chainId: net.chainId,
    owner: owner as Address,
    agent: agent as Address,
    guardian: ((guardians as readonly Address[])[0] ?? null) as Address | null,
    guardians: [...(guardians as readonly Address[])],
    threshold: Number(threshold),
    paused: paused as boolean,
    breakerTripped: breakerTripped as boolean,
    highWaterMark: highWaterMark as bigint,
    nav: navRead as bigint | null,
    policyHash: policyHash as `0x${string}`,
    mandate: {
      ...m,
      cooldown: Number(m.cooldown),
      twapWindow: Number(m.twapWindow),
      maxSlippageBps: Number(m.maxSlippageBps),
      minEdgeBps: Number(m.minEdgeBps),
      tiersMask: Number(m.tiersMask),
      assetsMask: Number(m.assetsMask),
      stopLossBps: Number(m.stopLossBps),
      takeProfitBps: Number(m.takeProfitBps),
      maxDrawdownBps: Number(m.maxDrawdownBps),
    },
    quoteBalance,
    quoteDecimals: net.quote.decimals,
    positions,
    dayVolume: vol,
    dayPnl: pnl,
    lastEntryAt: Number(lastEntryAt),
    readAt: Date.now(),
  };
}

/** A virtual vault for shadow/paper mode before a mainnet vault is funded. */
export function paperVaultState(net: NetworkConfig, usdtBalance = 10, mandate?: Partial<Mandate>): VaultState {
  const q = (x: number) => BigInt(Math.round(x * 10 ** net.quote.decimals));
  return {
    mode: "paper",
    address: null,
    chainId: net.chainId,
    owner: null,
    agent: null,
    guardian: null,
    guardians: [],
    threshold: 1,
    paused: false,
    breakerTripped: false,
    highWaterMark: 0n,
    nav: null,
    policyHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    mandate: {
      maxTradeQuote: q(1),
      dailyVolumeQuote: q(5),
      dailyLossQuote: q(0.5),
      maxExposureQuote: q(3),
      minArbProfitQuote: q(0.001),
      cooldown: 120,
      twapWindow: net.twapLongSec,
      maxSlippageBps: 100,
      minEdgeBps: 30,
      tiersMask: 7,
      assetsMask: (1 << net.pools.length) - 1,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 14 * 86400),
      minNetValueQuote: 0n,
      stopLossBps: 300,
      takeProfitBps: 0,
      maxDrawdownBps: 1000,
      ...mandate,
    },
    quoteBalance: q(usdtBalance),
    quoteDecimals: net.quote.decimals,
    positions: net.pools.map((p, i) => ({ asset: p.asset, token: p.base.address, index: i, qty: 0n, cost: 0n, balance: 0n, decimals: p.base.decimals, reentryBlockedUntil: 0 })),
    dayVolume: 0n,
    dayPnl: 0n,
    lastEntryAt: 0,
    readAt: Date.now(),
  };
}
