import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
import type { NetworkConfig } from "../config.js";

export function hskChain(net: NetworkConfig) {
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: net.rpcUrls } },
    blockExplorers: { default: { name: "Blockscout", url: net.explorer } },
    contracts: { multicall3: { address: net.multicall3 } },
  });
}

export function makeClient(net: NetworkConfig): PublicClient {
  const transports = net.rpcUrls.map((u) => http(u, { timeout: 10_000, retryCount: 2 }));
  return createPublicClient({
    chain: hskChain(net),
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    batch: { multicall: true },
  }) as PublicClient;
}
