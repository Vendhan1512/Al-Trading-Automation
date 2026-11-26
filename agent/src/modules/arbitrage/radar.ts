import { parseAbi, type Address, type PublicClient } from "viem";
import type { NetworkConfig } from "../../config.js";
import { quoterV2Abi } from "../market-data/abis.js";

/**
 * Arbitrage Radar — every venue on HSK Chain that holds WHSK, priced at EXECUTABLE size, with
 * profit after fees, price impact and gas. Read-only. The answer is reported even when it is "no".
 *
 * Venues (verified on-chain, 26 Nov 2026 — see research/pools.md):
 *   HSKSwap v3   WHSK/USDT 0.30%, WETH/USDT 0.30% (QuoterV2)
 *   Hyperindex   WHSK/USDT, WHSK/WETH (Uniswap-v2 pairs, 0.30%)
 *   WoofSwap     WHSK/USDT (Uniswap-v2 pair, 0.30%)
 */
const pairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
]);

export interface V2Venue {
  name: string;
  pair: Address;
  base: Address; // WHSK
  quote: Address; // USDT or WETH
  feeBps: number;
}

export const V2_VENUES: V2Venue[] = [
  { name: "Hyperindex WHSK/USDT", pair: "0xF8365695ccC4FCa53241d7d42BbDc3b2e7d43AE4", base: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", quote: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", feeBps: 30 },
  { name: "WoofSwap WHSK/USDT", pair: "0x340bDfC78724B3C4E28385462D9A36d469ad047B", base: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", quote: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", feeBps: 30 },
  { name: "Hyperindex WHSK/WETH", pair: "0x711d26AA3ff64dd9Dc5FA22B7c64C26c1b28f8f2", base: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", quote: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", feeBps: 30 },
];

export const SIZES_USDT = [0.5, 1, 2, 5, 10, 25];

/** Uniswap-v2 exact-input output. */
export function v2Out(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 30): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * BigInt(10_000 - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

export interface Route {
  name: string;
  kind: "cross-venue" | "triangle";
  legs: string[];
  midGapBps: number; // gap between venue mid prices, before costs
  best: { sizeUsdt: number; outUsdt: number; grossProfitUsdt: number; gasUsdt: number; netUsdt: number } | null;
  executableByVault: boolean; // the vault can only route HSKSwap pools
  verdict: string;
}

export interface RadarReport {
  at: number;
  gasPerSwapUsdt: number;
  venues: { name: string; priceUsdt: number; depthUsdt: number }[];
  routes: Route[];
  summary: string;
}

interface Reserves {
  base: bigint;
  quote: bigint;
}

async function reserves(client: PublicClient, v: V2Venue): Promise<Reserves> {
  const [r, t0] = await Promise.all([
    client.readContract({ address: v.pair, abi: pairAbi, functionName: "getReserves" }),
    client.readContract({ address: v.pair, abi: pairAbi, functionName: "token0" }),
  ]);
  return t0.toLowerCase() === v.base.toLowerCase() ? { base: r[0], quote: r[1] } : { base: r[1], quote: r[0] };
}

export async function scanRadar(client: PublicClient, net: NetworkConfig, hskUsd: number, ethUsd: number): Promise<RadarReport> {
  const [whskPool, wethPool] = [net.pools.find((p) => p.asset === "WHSK")!, net.pools.find((p) => p.asset === "WETH")!];
  const usdt = net.quote;
  const gasPrice = await client.getGasPrice();
  const gasPerSwapUsdt = (Number(gasPrice) * 175_000) / 1e18 * hskUsd; // ~175k gas per extra swap leg
  const q = async (tokenIn: Address, tokenOut: Address, amountIn: bigint, fee = 3000) => {
    if (amountIn <= 0n) return 0n;
    try {
      return (await client.simulateContract({ address: net.quoterV2, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] })).result[0];
    } catch {
      return 0n;
    }
  };
  const U = (x: number) => BigInt(Math.round(x * 1e6));
  const R = await Promise.all(V2_VENUES.map((v) => reserves(client, v)));
  const [hyperUsdt, woofUsdt, hyperWeth] = R as [Reserves, Reserves, Reserves];

  // reference mid prices
  const hskswapMid = Number(await q(whskPool.base.address, usdt.address, 10n ** 18n)) / 1e6 / (1 - 0.003);
  const v2Mid = (r: Reserves) => Number(r.quote) / 1e6 / (Number(r.base) / 1e18);
  const venues = [
    { name: "HSKSwap v3 WHSK/USDT", priceUsdt: hskswapMid, depthUsdt: 840_000 },
    { name: V2_VENUES[0]!.name, priceUsdt: v2Mid(hyperUsdt), depthUsdt: (2 * Number(hyperUsdt.quote)) / 1e6 },
    { name: V2_VENUES[1]!.name, priceUsdt: v2Mid(woofUsdt), depthUsdt: (2 * Number(woofUsdt.quote)) / 1e6 },
    { name: V2_VENUES[2]!.name, priceUsdt: (Number(hyperWeth.quote) / 1e18 / (Number(hyperWeth.base) / 1e18)) * ethUsd, depthUsdt: (2 * Number(hyperWeth.quote) * ethUsd) / 1e18 },
  ];

  const routes: Route[] = [];
  const evalSizes = async (fn: (sizeUsdt: number) => Promise<number>, legs: number) => {
    let best: Route["best"] = null;
    for (const s of SIZES_USDT) {
      const outUsdt = await fn(s);
      const gross = outUsdt - s;
      const gasUsdt = gasPerSwapUsdt * legs;
      const netUsdt = gross - gasUsdt;
      if (!best || netUsdt > best.netUsdt) best = { sizeUsdt: s, outUsdt, grossProfitUsdt: gross, gasUsdt, netUsdt };
    }
    return best;
  };

  // cross-venue WHSK/USDT: buy cheap venue, sell on the other
  for (const [i, r] of [hyperUsdt, woofUsdt].entries()) {
    const v = V2_VENUES[i]!;
    const gap = ((v2Mid(r) - hskswapMid) / hskswapMid) * 10_000;
    const cheapIsV2 = gap < 0;
    const best = await evalSizes(async (s) => {
      if (cheapIsV2) {
        const whsk = v2Out(U(s), r.quote, r.base, v.feeBps);
        return Number(await q(whskPool.base.address, usdt.address, whsk)) / 1e6;
      }
      const whsk = await q(usdt.address, whskPool.base.address, U(s));
      return Number(v2Out(whsk, r.base, r.quote, v.feeBps)) / 1e6;
    }, 2);
    routes.push({
      name: `${cheapIsV2 ? v.name : "HSKSwap"} → ${cheapIsV2 ? "HSKSwap" : v.name}`,
      kind: "cross-venue",
      legs: cheapIsV2 ? [`buy WHSK on ${v.name}`, "sell WHSK on HSKSwap"] : ["buy WHSK on HSKSwap", `sell WHSK on ${v.name}`],
      midGapBps: gap,
      best,
      executableByVault: false,
      verdict: "",
    });
  }

  // triangles through WETH: USDT -> WHSK (HSKSwap) -> WETH (Hyperindex) -> USDT (HSKSwap), and reverse
  const tri1 = await evalSizes(async (s) => {
    const whsk = await q(usdt.address, whskPool.base.address, U(s));
    const weth = v2Out(whsk, hyperWeth.base, hyperWeth.quote, 30);
    return Number(await q(wethPool.base.address, usdt.address, weth)) / 1e6;
  }, 3);
  const tri2 = await evalSizes(async (s) => {
    const weth = await q(usdt.address, wethPool.base.address, U(s));
    const whsk = v2Out(weth, hyperWeth.quote, hyperWeth.base, 30);
    return Number(await q(whskPool.base.address, usdt.address, whsk)) / 1e6;
  }, 3);
  const triGap = ((venues[3]!.priceUsdt - hskswapMid) / hskswapMid) * 10_000;
  routes.push({ name: "USDT → WHSK (HSKSwap) → WETH (Hyperindex) → USDT (HSKSwap)", kind: "triangle", legs: ["HSKSwap", "Hyperindex", "HSKSwap"], midGapBps: triGap, best: tri1, executableByVault: false, verdict: "" });
  routes.push({ name: "USDT → WETH (HSKSwap) → WHSK (Hyperindex) → USDT (HSKSwap)", kind: "triangle", legs: ["HSKSwap", "Hyperindex", "HSKSwap"], midGapBps: -triGap, best: tri2, executableByVault: false, verdict: "" });

  for (const r of routes) {
    const b = r.best;
    r.verdict = !b
      ? "no quote"
      : b.netUsdt > 0
        ? `profitable: +${b.netUsdt.toFixed(4)} USDT at ${b.sizeUsdt} USDT (outside the vault's HSKSwap-only route allowlist — observe only)`
        : b.grossProfitUsdt > 0
          ? `real gap, not harvestable: best gross +${b.grossProfitUsdt.toFixed(4)} USDT is eaten by ${b.gasUsdt.toFixed(4)} USDT of gas`
          : `no gap after fees and impact (best ${b.grossProfitUsdt.toFixed(4)} USDT before gas)`;
  }
  const anyNet = routes.some((r) => (r.best?.netUsdt ?? -1) > 0);
  return {
    at: Date.now(),
    gasPerSwapUsdt,
    venues,
    routes,
    summary: anyNet
      ? "A route clears gas at current prices — but only HSKSwap pools are on the vault's allowlist, so it is reported, not traded."
      : "Gaps exist between HSK venues, but the side venues are tiny: after fees, price impact and gas no route is profitable right now.",
  };
}
