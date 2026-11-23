/** Price helpers for Uniswap-V3 pools. Prices are returned as "quote per 1 base" in human units. */

const Q96 = 2 ** 96;

/** Human price of token0 denominated in token1, from sqrtPriceX96. */
export function priceFromSqrtX96(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const r = Number(sqrtPriceX96) / Q96;
  return r * r * 10 ** (dec0 - dec1);
}

/** Human price of token0 denominated in token1, from a tick. */
export function priceFromTick(tick: number, dec0: number, dec1: number): number {
  return 1.0001 ** tick * 10 ** (dec0 - dec1);
}

/** Arithmetic-mean tick between two tickCumulatives, rounded toward -infinity (OracleLibrary). */
export function meanTick(cumNow: bigint, cumAgo: bigint, seconds: number): number {
  const delta = cumNow - cumAgo;
  const s = BigInt(seconds);
  let t = delta / s;
  if (delta < 0n && delta % s !== 0n) t -= 1n;
  return Number(t);
}

/** Price of `base` in `quote` given a pool's token ordering. */
export function orientPrice(priceToken0InToken1: number, baseIsToken0: boolean): number {
  return baseIsToken0 ? priceToken0InToken1 : 1 / priceToken0InToken1;
}

export function bps(a: number, b: number): number {
  return ((a - b) / b) * 10_000;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function toUnits(amount: number, decimals: number): bigint {
  // avoid float artefacts for small decimals
  const [i, f = ""] = amount.toFixed(Math.min(decimals, 12)).split(".");
  return BigInt(i! + f.padEnd(decimals, "0").slice(0, decimals));
}

export function fromUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
