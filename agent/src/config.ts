import type { Address } from "viem";

/** Asset symbols the agent understands. WHSK is quoted against HSK references. */
export type AssetSymbol = "WHSK" | "WETH" | "WBTC";

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface PoolInfo {
  asset: AssetSymbol;
  address: Address;
  fee: number;
  base: TokenInfo; // the asset
  quote: TokenInfo; // USDT
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrls: string[];
  explorer: string;
  multicall3: Address;
  quoterV2: Address;
  router: Address;
  v3Factory: Address;
  vaultFactory: Address;
  apro?: { address: Address; decimals: number; heartbeatSec: number };
  quote: TokenInfo;
  pools: PoolInfo[];
  twapShortSec: number;
  twapLongSec: number;
}

const USDT: TokenInfo = { symbol: "USDT", address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", decimals: 6 };
const WHSK: TokenInfo = { symbol: "WHSK", address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", decimals: 18 };
const WETH: TokenInfo = { symbol: "WETH", address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", decimals: 18 };
const WBTC: TokenInfo = { symbol: "WBTC", address: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14", decimals: 8 };

/** HSK Chain mainnet — every address verified on-chain (see research/pools.md). */
export const MAINNET: NetworkConfig = {
  chainId: 177,
  name: "HashKey Chain",
  rpcUrls: ["https://mainnet.hsk.xyz"],
  explorer: "https://hsk.blockscout.com",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  quoterV2: "0x1095A23A4812185344D9abd5143191D8a3A7E36f",
  router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
  v3Factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
  vaultFactory: "0x28ae19424647A051b95944DB26ffC0102085fBfE",
  apro: { address: "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b", decimals: 8, heartbeatSec: 25 * 3600 },
  quote: USDT,
  pools: [
    { asset: "WHSK", address: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC", fee: 3000, base: WHSK, quote: USDT },
    { asset: "WETH", address: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16", fee: 3000, base: WETH, quote: USDT },
    { asset: "WBTC", address: "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A", fee: 3000, base: WBTC, quote: USDT },
  ],
  twapShortSec: 300,
  twapLongSec: 1800,
};

/** Order sizes (in USDT) at which executable quotes are sampled to build an impact curve. */
export const QUOTE_SIZES_USDT = [0.5, 2, 10, 50] as const;

/** Data Reliability policy. All thresholds in basis points / seconds. */
export interface ReliabilityPolicy {
  maxBlockAgeSec: number; // chain head older than this => WAIT
  rejectBlockAgeSec: number; // => REJECT
  maxRefAgeSec: number; // exchange quote older than this => stale
  maxRefSpreadBps: number; // wider book => unreliable source
  maxRefDeviationBps: number; // a source this far from the median is an outlier
  minFreshRefs: number; // VALID needs at least this many agreeing sources
  spotVsTwapWarnBps: number;
  spotVsTwapRejectBps: number; // spike / manipulation guard
  maxPlausiblePremiumBps: number; // |DEX vs reference| beyond this is treated as bad data
  oracleWarnBps: number; // APRO vs reference median
}

export const DEFAULT_POLICY: ReliabilityPolicy = {
  maxBlockAgeSec: 30,
  rejectBlockAgeSec: 120,
  maxRefAgeSec: 30,
  maxRefSpreadBps: 200,
  maxRefDeviationBps: 150,
  minFreshRefs: 2,
  spotVsTwapWarnBps: 100,
  spotVsTwapRejectBps: 400,
  maxPlausiblePremiumBps: 1000,
  oracleWarnBps: 300,
};
