import type { PublicClient } from "viem";
import { QUOTE_SIZES_USDT, type NetworkConfig, type PoolInfo } from "../../config.js";
import { fromUnits, meanTick, orientPrice, priceFromSqrtX96, priceFromTick, toUnits } from "../../common/math.js";
import { poolAbi, quoterV2Abi } from "./abis.js";
import type { PoolObservation, QuotePoint } from "./types.js";

export function baseIsToken0(p: PoolInfo): boolean {
  return p.base.address.toLowerCase() < p.quote.address.toLowerCase();
}

/** Reads spot, liquidity and the short/long TWAP of one pool in a single multicall. */
export async function readPoolState(client: PublicClient, net: NetworkConfig, p: PoolInfo, blockNumber: bigint) {
  const [slot0, liquidity, observed] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: p.address, abi: poolAbi, functionName: "slot0" },
      { address: p.address, abi: poolAbi, functionName: "liquidity" },
      { address: p.address, abi: poolAbi, functionName: "observe", args: [[net.twapLongSec, net.twapShortSec, 0]] },
    ],
  });
  const b0 = baseIsToken0(p);
  const [dec0, dec1] = b0 ? [p.base.decimals, p.quote.decimals] : [p.quote.decimals, p.base.decimals];
  const [cumLong, cumShort, cumNow] = observed[0] as readonly bigint[];
  const tLong = meanTick(cumNow!, cumLong!, net.twapLongSec);
  const tShort = meanTick(cumNow!, cumShort!, net.twapShortSec);
  return {
    spot: orientPrice(priceFromSqrtX96(slot0[0], dec0, dec1), b0),
    tick: slot0[1],
    liquidity: liquidity.toString(),
    twapLong: orientPrice(priceFromTick(tLong, dec0, dec1), b0),
    twapShort: orientPrice(priceFromTick(tShort, dec0, dec1), b0),
  };
}

/** Samples executable QuoterV2 quotes at several sizes in both directions (eth_call only). */
export async function readQuotes(client: PublicClient, net: NetworkConfig, p: PoolInfo, spot: number) {
  const feeFrac = p.fee / 1e6;
  const jobs: Promise<QuotePoint | null>[] = [];
  for (const size of QUOTE_SIZES_USDT) {
    for (const side of ["BUY", "SELL"] as const) {
      const tokenIn = side === "BUY" ? p.quote : p.base;
      const tokenOut = side === "BUY" ? p.base : p.quote;
      const amountInHuman = side === "BUY" ? size : size / spot;
      const amountIn = toUnits(amountInHuman, tokenIn.decimals);
      jobs.push(
        client
          .simulateContract({
            address: net.quoterV2,
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
          })
          .then(({ result }) => {
            const out = fromUnits(result[0], tokenOut.decimals);
            const inn = fromUnits(amountIn, tokenIn.decimals);
            const effectivePrice = side === "BUY" ? inn / out : out / inn;
            // impact vs spot with the pool fee removed; positive = worse than spot
            const impactBps =
              side === "BUY"
                ? (effectivePrice / (spot / (1 - feeFrac)) - 1) * 10_000
                : (1 - effectivePrice / (spot * (1 - feeFrac))) * 10_000;
            return {
              sizeUsdt: size,
              side,
              amountIn: amountIn.toString(),
              amountOut: result[0].toString(),
              effectivePrice,
              impactBps,
            } satisfies QuotePoint;
          })
          .catch(() => null),
      );
    }
  }
  return (await Promise.all(jobs)).filter((q): q is QuotePoint => q !== null);
}

export async function observePool(
  client: PublicClient,
  net: NetworkConfig,
  p: PoolInfo,
  head: { blockNumber: bigint; blockTimestamp: number },
): Promise<PoolObservation> {
  try {
    const s = await readPoolState(client, net, p, head.blockNumber);
    const quotes = await readQuotes(client, net, p, s.spot);
    return {
      asset: p.asset,
      pool: p.address,
      fee: p.fee,
      blockNumber: Number(head.blockNumber),
      blockTimestamp: head.blockTimestamp,
      ...s,
      quotes,
    };
  } catch (e) {
    return {
      asset: p.asset,
      pool: p.address,
      fee: p.fee,
      blockNumber: Number(head.blockNumber),
      blockTimestamp: head.blockTimestamp,
      spot: NaN,
      twapShort: NaN,
      twapLong: NaN,
      liquidity: "0",
      tick: 0,
      quotes: [],
      error: (e as Error).message.split("\n")[0],
    };
  }
}
