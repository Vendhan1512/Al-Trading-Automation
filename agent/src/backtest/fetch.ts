import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PublicClient } from "viem";
import { MAINNET, type PoolInfo } from "../config.js";
import { makeClient } from "../common/chain.js";
import { poolAbi } from "../modules/market-data/abis.js";

/**
 * Downloads (and caches) the data the backtest replays:
 *   - every Swap on the three HSKSwap pools over the last DAYS days (sqrtPrice, tick, block)
 *   - block timestamps sampled every 10k blocks (interpolated in between; HSK blocks are ~2 s)
 *   - Gate.io 5-minute candles for HSK, ETH and BTC against USDT
 */
export const DAYS = Number(process.env.BACKTEST_DAYS ?? 30);
const DIR = "./data/backtest";
const CHUNK = 5_000n;

export interface SwapPoint {
  block: number;
  ts: number; // seconds
  sqrtPriceX96: string;
  tick: number;
}
export interface Candle {
  ts: number; // seconds, candle open
  close: number;
}

const cache = <T,>(name: string, make: () => Promise<T>) => async (): Promise<T> => {
  const f = `${DIR}/${name}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as T;
  const v = await make();
  mkdirSync(DIR, { recursive: true });
  writeFileSync(f, JSON.stringify(v));
  return v;
};

async function blockClock(client: PublicClient, from: bigint, to: bigint): Promise<(b: number) => number> {
  const samples: [number, number][] = [];
  for (let b = from; b <= to; b += 10_000n) samples.push([Number(b), Number((await client.getBlock({ blockNumber: b })).timestamp)]);
  samples.push([Number(to), Number((await client.getBlock({ blockNumber: to })).timestamp)]);
  return (b: number) => {
    let i = samples.findIndex(([sb]) => sb >= b);
    if (i <= 0) i = 1;
    const [b0, t0] = samples[i - 1]!;
    const [b1, t1] = samples[i] ?? samples[i - 1]!;
    return b1 === b0 ? t0 : Math.round(t0 + ((b - b0) * (t1 - t0)) / (b1 - b0));
  };
}

async function swaps(client: PublicClient, p: PoolInfo, from: bigint, to: bigint, clock: (b: number) => number): Promise<SwapPoint[]> {
  const out: SwapPoint[] = [];
  for (let s = from; s <= to; s += CHUNK) {
    const e = s + CHUNK - 1n < to ? s + CHUNK - 1n : to;
    const logs = await client.getContractEvents({ address: p.address, abi: poolAbi, eventName: "Swap", fromBlock: s, toBlock: e });
    for (const l of logs) {
      const a = l.args as { sqrtPriceX96: bigint; tick: number };
      out.push({ block: Number(l.blockNumber), ts: clock(Number(l.blockNumber)), sqrtPriceX96: a.sqrtPriceX96.toString(), tick: Number(a.tick) });
    }
  }
  return out;
}

async function gateCandles(pair: string, fromTs: number, toTs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let s = fromTs; s < toTs; s += 1000 * 300) {
    const e = Math.min(toTs, s + 999 * 300);
    const r = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=5m&from=${s}&to=${e}`);
    if (!r.ok) throw new Error(`gate ${pair}: HTTP ${r.status}`);
    for (const c of (await r.json()) as string[][]) out.push({ ts: Number(c[0]), close: Number(c[2]) });
  }
  return out.sort((a, b) => a.ts - b.ts).filter((c, i, arr) => i === 0 || c.ts !== arr[i - 1]!.ts);
}

export async function loadHistory() {
  const client = makeClient(MAINNET);
  const meta = await cache("meta", async () => {
    const head = await client.getBlockNumber();
    const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
    return { head: head.toString(), from: (head - BigInt(DAYS * 43_200)).toString(), headTs };
  })();
  const from = BigInt(meta.from);
  const to = BigInt(meta.head);
  let clock: ((b: number) => number) | null = null;
  const getClock = async () => (clock ??= await blockClock(client, from, to));
  const pools: Record<string, SwapPoint[]> = {};
  for (const p of MAINNET.pools) {
    pools[p.asset] = await cache(`swaps-${p.asset}`, async () => swaps(client, p, from, to, await getClock()))();
    console.log(`[backtest] ${p.asset}: ${pools[p.asset]!.length} swaps`);
  }
  const startTs = meta.headTs - DAYS * 86_400;
  const cex: Record<string, Candle[]> = {};
  for (const [asset, pair] of [["WHSK", "HSK_USDT"], ["WETH", "ETH_USDT"], ["WBTC", "BTC_USDT"]] as const) {
    cex[asset] = await cache(`gate-${pair}`, () => gateCandles(pair, startTs, meta.headTs))();
    console.log(`[backtest] ${pair}: ${cex[asset]!.length} candles`);
  }
  return { meta, pools, cex, startTs, endTs: meta.headTs };
}
