import type { PublicClient } from "viem";
import type { NetworkConfig } from "../../config.js";
import { readFlow } from "./flow.js";
import { observePool } from "./pools.js";
import { fetchApro, fetchCexReferences } from "./references.js";
import type { FlowStats, MarketSnapshot } from "./types.js";

/** One complete observation of every market the agent watches. Never throws. */
export async function takeSnapshot(
  client: PublicClient,
  net: NetworkConfig,
  opts: { withFlow?: boolean } = {},
): Promise<MarketSnapshot> {
  const takenAt = Date.now();
  const errors: string[] = [];
  const assets = net.pools.map((p) => p.asset);
  const refsP = fetchCexReferences(assets);

  let head: MarketSnapshot["head"] = null;
  try {
    const t0 = Date.now();
    const b = await client.getBlock({ blockTag: "latest" });
    head = { blockNumber: Number(b.number), blockTimestamp: Number(b.timestamp), rpcLatencyMs: Date.now() - t0 };
  } catch (e) {
    errors.push(`rpc: ${(e as Error).message.split("\n")[0]}`);
  }

  if (!head) {
    return { takenAt, chainId: net.chainId, head, pools: [], references: await refsP, flows: [], errors };
  }

  const h = { blockNumber: BigInt(head.blockNumber), blockTimestamp: head.blockTimestamp };
  const [pools, apro, flows] = await Promise.all([
    Promise.all(net.pools.map((p) => observePool(client, net, p, h))),
    fetchApro(client, net),
    opts.withFlow
      ? Promise.all(
          net.pools.map((p) =>
            readFlow(client, net, p, h.blockNumber).catch((e) => {
              errors.push(`flow ${p.asset}: ${(e as Error).message.split("\n")[0]}`);
              return null;
            }),
          ),
        )
      : Promise.resolve([]),
  ]);
  const references = await refsP;
  if (apro) references.push(apro);
  for (const p of pools) if (p.error) errors.push(`pool ${p.asset}: ${p.error}`);
  return {
    takenAt,
    chainId: net.chainId,
    head,
    pools,
    references,
    flows: flows.filter((f): f is FlowStats => f !== null),
    errors,
  };
}
