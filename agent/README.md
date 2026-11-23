# Countersign agent

TypeScript (Node ≥ 22.13) · viem · zod · vitest · built-in `node:sqlite`

## Phase 2: market intelligence (done)
| Module | Role |
|---|---|
| `modules/market-data/pools.ts` | Reads each HSKSwap pool in one multicall: spot (`slot0`), in-range liquidity, 5-min and 30-min TWAP (`observe`). Samples **executable QuoterV2 quotes** at $0.5 / $2 / $10 / $50 in both directions to build an impact curve |
| `modules/market-data/references.ts` | Key-less exchange books: HashKey Global, Gate, MEXC (HSK, ETH, BTC) and Coinbase (ETH, BTC). Every response is zod-validated. Also reads the APRO HSK/USD on-chain feed through a raw `eth_call`, because APRO whitelists contract callers and Multicall3 is a contract |
| `modules/market-data/flow.ts` | Swap-event flow over about 6 h (buy/sell volume, last swap). Reads in 5k-block chunks because the HSK RPC caps `eth_getLogs` ranges |
| `modules/data-reliability/engine.ts` | **Data Reliability Engine** (pure, deterministic): VALID / WARNING / WAIT / REJECT with coded findings |
| `common/store.ts` | Append-only SQLite (`market_snapshots`, `market_health`), enforced by triggers |
| `workers/market-monitor.ts` | Always-on loop: snapshot → verdict → store. Each tick is scheduled from the end of the previous one, so ticks never overlap |
| `api/server.ts` | Keeper process: monitor plus a read-only HTTP API |

### Reliability rules
| Rule | Result |
|---|---|
| No RPC / chain head > 120 s old | **REJECT** for every asset (Scenario 9) |
| Chain head > 30 s old | WAIT |
| Pool read failed / zero liquidity | REJECT |
| Spot ≥ 400 bps from the 5-min TWAP | REJECT (spike or manipulation) · ≥ 100 bps → WARNING |
| Exchange quote stale (> 30 s), crossed, book wider than 200 bps, or > 150 bps from the median | that source is **excluded** with a reason (Scenario 1) |
| 0 reliable references / 1 reference | WAIT / WARNING |
| DEX vs reference > 1000 bps | REJECT (implausible, treated as bad data) |
| APRO older than its 25 h heartbeat | excluded. A fresh print > 300 bps off → WARNING. It is never the execution price |

## Run
```bash
pnpm install
pnpm --filter @countersign/agent snapshot            # one-shot live verdict
pnpm --filter @countersign/agent api                 # keeper: monitor + API on :8787
pnpm --filter @countersign/agent test                # 25 unit tests (offline)
LIVE=1 pnpm --filter @countersign/agent exec vitest run test/live.test.ts   # live mainnet test
```
API (read-only, CORS open): `/api/market/health`, `/prices`, `/liquidity`, `/volume`, `/snapshot`, `/history?asset=WBTC`.
If the monitor stops, `/health` reports `WAIT` once the last verdict is older than 3 intervals.
