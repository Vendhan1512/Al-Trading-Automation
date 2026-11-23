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

## Phase 3: strategy and AI (done)
| Module | Role |
|---|---|
| `modules/strategies/candidates.ts` | Deterministic candidates. **Tier A**: distinct-pool cycle scanner (HSKSwap is a star around USDT today, so it reports none). **Tier B**: spread reversion. BUY when `premium ≤ −(pool fee + impact + mandate minEdge + buffer)`; SELL tracked inventory when the pool is rich. Targets assume only **half** the gap closes on the pool. **Tier C**: z-score mean reversion vs recent pool history, long-only, half size |
| `modules/strategy-filter/filter.ts` | Deterministic, runs **before** the LLM: data quality, signal expiry, mandate expiry, tier and asset, pause, cooldown (WAIT), daily loss, conflicting signals, in-flight trades, no gross edge |
| `modules/ai-strategist/strategist.ts` | Claude (`claude-opus-5-5`, structured output via `betaZodOutputFormat`, server-side refusal fallbacks `fallbacks: "default"`, effort `medium`, cached frozen system prompt). It may only **TAKE or SKIP, and shrink size**. Code re-enforces every bound: clamps size and probability, replaces bad target/invalidation levels, ignores unknown candidates. With no credentials, a refusal or an error, it degrades to **rules-only** (Tier B taken, Tier C skipped) |
| `modules/predictions/prediction.ts` | Sworn prediction: canonical JSON → keccak256. The hash goes into the permit and the `TradeExecuted` event |

## Phase 4: Guardian (done)
A **separate process with its own key** (`pnpm guardian`, `127.0.0.1:8788`). `common/env.ts` gives each role only its own secret, and each process refuses to start if the other role's key is visible. A test enforces that no agent module imports the Guardian service.

The Guardian takes only *intent* from the agent (asset, side, size, tier, prediction). It then does all of the following itself:
1. Confirms the vault is from the Countersign factory and that this key is its registered Guardian.
2. Checks the prediction hash against the prediction payload.
3. Takes **its own** market snapshot and reliability verdict.
4. Re-quotes on QuoterV2 for 1, 2 and 3 legs.
5. Reads the vault's own `twapFloor`.
6. Runs `guardian/validate.ts`, which is pure and deterministic. It mirrors the mandate (cap, daily volume, daily loss, exposure, cash, cooldown, pause, tier, asset, expiry), checks the TWAP floor, price impact and **edge-or-revert**, computes **expected net value after entry fee, impact, exit fee and gas both ways**, checks **portfolio concentration and total exposure**, counts **in-flight reservations**, and builds an **adaptive execution plan** (immediate vs split, with legs spaced by the vault cooldown).
7. Signs an EIP-712 permit. The digest is verified against the deployed vault's `permitDigest`.
8. **Simulates the exact `execute` call from the agent address** before returning it.

`?dryRun=1` evaluates without ever signing, which the copilot uses for "what-if".

### Economics finding (from a live run, 23 Nov 2026)
WBTC's pool sat about 160 bps below the exchanges, which is a real 105–111 bps edge after the pool fee. For a **1 USDT** trade the Guardian still returned **WAIT, net −0.017 USDT**, because one vault swap costs about **$0.012 of gas** at 500 gwei (about $0.024 for a round trip). Break-even is roughly **3 USDT per trade** at today's gap. The owner console now defaults to a **5 USDT** per-trade cap for that reason.

## Run the whole system
```bash
pnpm --filter @countersign/agent guardian          # terminal 1 — Guardian (GUARDIAN_PK only)
pnpm --filter @countersign/agent agent             # terminal 2 — agent (AGENT_PK only), AGENT_MODE=shadow by default
# live trading: VAULT=0x<mainnet vault> AGENT_MODE=live pnpm --filter @countersign/agent agent
```
Agent API adds `/api/agent/decisions` and `/api/agent/decision?seq=N`, the full record for one decision: candidate, filter, strategist, prediction, Guardian checks, execution.

Tests: **65 unit tests + 2 live tests**. The live tests read mainnet and compare the permit digest with the deployed vault.
