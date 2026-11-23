import { z } from "zod";
import { decodeFunctionResult, encodeFunctionData, type PublicClient } from "viem";
import type { AssetSymbol, NetworkConfig } from "../../config.js";
import { aggregatorV3Abi } from "./abis.js";
import type { ReferenceQuote } from "./types.js";

/**
 * Public, key-less market-data endpoints. Exchange data is UNTRUSTED input: every response is
 * schema-validated, and nothing from it is ever passed to the LLM as free text.
 */
type Parsed = { bid: number | null; ask: number | null; sourceTs: number | null };

interface Source {
  name: string;
  symbols: Partial<Record<AssetSymbol, string>>;
  url: (symbol: string) => string;
  parse: (json: unknown) => Parsed;
}

const num = z.union([z.string(), z.number()]).transform((v) => Number(v));
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split(/\r?\n/)[0]!.slice(0, 120);

export const SOURCES: Source[] = [
  {
    name: "hashkey",
    symbols: { WHSK: "HSKUSDT", WETH: "ETHUSDT", WBTC: "BTCUSDT" },
    url: (s) => `https://api-glb.hashkey.com/quote/v1/ticker/bookTicker?symbol=${s}`,
    parse: (j) => {
      const r = z.array(z.object({ b: num, a: num, t: z.number() })).nonempty().parse(j)[0];
      return { bid: r.b, ask: r.a, sourceTs: r.t };
    },
  },
  {
    name: "gate",
    symbols: { WHSK: "HSK_USDT", WETH: "ETH_USDT", WBTC: "BTC_USDT" },
    url: (s) => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${s}`,
    parse: (j) => {
      const r = z.array(z.object({ highest_bid: num, lowest_ask: num })).nonempty().parse(j)[0];
      return { bid: r.highest_bid, ask: r.lowest_ask, sourceTs: null };
    },
  },
  {
    name: "mexc",
    symbols: { WHSK: "HSKUSDT", WETH: "ETHUSDT", WBTC: "BTCUSDT" },
    url: (s) => `https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${s}`,
    parse: (j) => {
      const r = z.object({ bidPrice: num, askPrice: num }).parse(j);
      return { bid: r.bidPrice, ask: r.askPrice, sourceTs: null };
    },
  },
  {
    // USD (not USDT) market: a small USD/USDT basis is expected; the median absorbs it.
    name: "coinbase",
    symbols: { WETH: "ETH-USD", WBTC: "BTC-USD" },
    url: (s) => `https://api.exchange.coinbase.com/products/${s}/ticker`,
    parse: (j) => {
      const r = z.object({ bid: num, ask: num, time: z.string() }).parse(j);
      return { bid: r.bid, ask: r.ask, sourceTs: Date.parse(r.time) };
    },
  },
];

export function toQuote(source: string, asset: AssetSymbol, p: Parsed, fetchedAt: number, latencyMs: number): ReferenceQuote {
  const valid = p.bid !== null && p.ask !== null && p.bid > 0 && p.ask > 0;
  return {
    source,
    asset,
    bid: p.bid,
    ask: p.ask,
    mid: valid ? (p.bid! + p.ask!) / 2 : NaN,
    sourceTs: p.sourceTs,
    fetchedAt,
    latencyMs,
    kind: "cex",
    ...(valid ? {} : { error: "invalid book" }),
  };
}

async function fetchOne(src: Source, asset: AssetSymbol, symbol: string, timeoutMs: number): Promise<ReferenceQuote> {
  const t0 = Date.now();
  try {
    const res = await fetch(src.url(symbol), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "user-agent": "countersign-agent/0.1" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = src.parse(await res.json());
    const now = Date.now();
    return toQuote(src.name, asset, parsed, now, now - t0);
  } catch (e) {
    const now = Date.now();
    return {
      source: src.name,
      asset,
      bid: null,
      ask: null,
      mid: NaN,
      sourceTs: null,
      fetchedAt: now,
      latencyMs: now - t0,
      kind: "cex",
      error: firstLine(e),
    };
  }
}

export async function fetchCexReferences(assets: AssetSymbol[], timeoutMs = 5_000): Promise<ReferenceQuote[]> {
  const jobs: Promise<ReferenceQuote>[] = [];
  for (const src of SOURCES) {
    for (const a of assets) {
      const sym = src.symbols[a];
      if (sym) jobs.push(fetchOne(src, a, sym, timeoutMs));
    }
  }
  return Promise.all(jobs);
}

/** APRO HSK/USD on-chain feed (heartbeat/deviation oracle). Used as a sanity reference only. */
export async function fetchApro(client: PublicClient, net: NetworkConfig): Promise<ReferenceQuote | null> {
  if (!net.apro) return null;
  const t0 = Date.now();
  try {
    // APRO read-whitelists contract callers. viem batches readContract AND call() through
    // Multicall3 (a contract), so issue a raw eth_call that can never be batched.
    const data = (await client.request({
      method: "eth_call",
      params: [{ to: net.apro.address, data: encodeFunctionData({ abi: aggregatorV3Abi, functionName: "latestRoundData" }) }, "latest"],
    })) as `0x${string}`;
    const [, answer, , updatedAt] = decodeFunctionResult({
      abi: aggregatorV3Abi,
      functionName: "latestRoundData",
      data,
    });
    const mid = Number(answer) / 10 ** net.apro.decimals;
    const now = Date.now();
    return {
      source: "apro",
      asset: "WHSK",
      bid: null,
      ask: null,
      mid,
      sourceTs: Number(updatedAt) * 1000,
      fetchedAt: now,
      latencyMs: now - t0,
      kind: "oracle",
    };
  } catch (e) {
    const now = Date.now();
    return {
      source: "apro",
      asset: "WHSK",
      bid: null,
      ask: null,
      mid: NaN,
      sourceTs: null,
      fetchedAt: now,
      latencyMs: now - t0,
      kind: "oracle",
      error: firstLine(e),
    };
  }
}
