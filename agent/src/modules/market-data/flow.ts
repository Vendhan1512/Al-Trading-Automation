import type { PublicClient } from "viem";
import type { NetworkConfig, PoolInfo } from "../../config.js";
import { fromUnits } from "../../common/math.js";
import { poolAbi } from "./abis.js";
import { baseIsToken0 } from "./pools.js";
import type { FlowStats } from "./types.js";

/** Swap flow over the last `lookbackBlocks` blocks (HSK: ~2 s blocks; 10800 blocks ≈ 6 h). */
export async function readFlow(
  client: PublicClient,
  _net: NetworkConfig,
  p: PoolInfo,
  toBlock: bigint,
  lookbackBlocks = 10_800n,
): Promise<FlowStats> {
  const fromBlock = toBlock > lookbackBlocks ? toBlock - lookbackBlocks : 0n;
  // The HSK RPC rejects eth_getLogs ranges above ~10k blocks ("block range too large").
  const CHUNK = 5_000n;
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < toBlock ? from + CHUNK - 1n : toBlock;
    logs.push(...(await client.getContractEvents({ address: p.address, abi: poolAbi, eventName: "Swap", fromBlock: from, toBlock: to })));
  }
  const quoteIs1 = baseIsToken0(p);
  let buy = 0;
  let sell = 0;
  let lastBlock: bigint | null = null;
  for (const l of logs) {
    const a = l.args as { amount0: bigint; amount1: bigint };
    const quoteDelta = quoteIs1 ? a.amount1 : a.amount0; // positive = USDT paid into pool
    const usd = fromUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, p.quote.decimals);
    if (quoteDelta > 0n) buy += usd;
    else sell += usd;
    lastBlock = l.blockNumber;
  }
  let lastSwapTs: number | null = null;
  if (lastBlock !== null) {
    const b = await client.getBlock({ blockNumber: lastBlock });
    lastSwapTs = Number(b.timestamp) * 1000;
  }
  return {
    asset: p.asset,
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    swaps: logs.length,
    buyVolumeUsdt: buy,
    sellVolumeUsdt: sell,
    netFlowUsdt: buy - sell,
    lastSwapTs,
  };
}
