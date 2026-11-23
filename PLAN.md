# Build Plan — Countersign (AI-Powered Autonomous DeFi Trading Platform)

> **Concept:** see [IDEA.md](IDEA.md). Two-key execution (the AI proposes, an independent Guardian countersigns an EIP-712 Execution Permit, the vault enforces it, the owner controls), Proof-of-Edge tiers A/B/C, and the Mission Control copilot. Where the two files disagree, IDEA.md wins.

HSK Chain Horizon Hackathon (Seoul), Track 1: AI Agent Trading

| Milestone | Date |
|---|---|
| Plan written | Mon 23 Nov 2026 |
| Contracts frozen, deployed to mainnet | Fri 27 Nov |
| Agent trading live on mainnet (small sizes) | Sat 28 Nov |
| Feature freeze | Tue 1 Dec, end of day |
| **Our submission target** | **Wed 2 Dec, 20:00 KST** (one day of slack) |
| Hard deadline | Thu 3 Dec, 13:00 KST (04:00 UTC) |
| Pitch list announced / Demo Day | 4 Dec / 5 Dec |

That gives about 9 working days. The project document describes a product that would take months to build. This plan keeps its architecture and its story, builds a working slice of every layer, and cuts infrastructure that judges never see.

---

## 1. Strategy: how this entry wins

### 1.1 What the judges have already seen
| Project | What it covered |
|---|---|
| Nalvis (previous edition, 1st) | Ledger-owned vault, signed mandate, LLM Strategist/Fitter, receipts and verifier, Copilot |
| Avow (2nd) | Prediction sworn in the same tx as the swap, on-chain Brier grading, ERC-8004 reputation |
| Waypoint (3rd) | Chat-configured spread/mean-reversion agent, hard-coded risk limits, paper mode |
| Keel (this edition) | Vault with cap, slippage floor, cooldown and daily loss; APRO mean reversion; chat desk |
| SayTrade (this edition) | Natural-language strategy parser, TWAP-guarded vault |

**About 70% of our document (Ledger plus mandate plus vault plus sworn predictions plus evidence) has already been shown and has already won.** If we build only that, we come across as a re-implementation of Nalvis plus Avow. The vault and mandate are now the minimum entry. They are not what sets us apart.

### 1.2 Where we differ
The track brief asks for things no previous or current entry has fully delivered:

1. **Arbitrage you can verify (headline feature).** Every entry so far does CEX-to-DEX *spread* trading. That is directional risk dressed up as arbitrage. We add **atomic on-chain arbitrage**: a multi-hop or cross-pool cycle on HSKSwap executes in one vault transaction with a contract-enforced `minProfit`, so it either makes money or reverts. The only cost of a failed attempt is gas. The claim "it spotted arbitrage" becomes something judges can check in a transaction.
2. **Execution Guardian that prices costs before trading.** It computes expected net value after both pool fees, measured price impact (QuoterV2), gas and an exit-cost estimate. It shows the arithmetic for every APPROVE, WAIT or REJECT. Avow's research showed that naive strategies lose money on 0.30% pools. We say this openly and show that the Guardian knows it.
3. **Adaptive execution.** We compare a single order, a split order and waiting, using real quotes, and show the numbers.
4. **Portfolio-level risk across several assets** (WHSK, WETH, WBTC against USDT). Competitors trade one pair.
5. **Smart Trade Recovery that we demonstrate.** We stage a stuck or replaced transaction live and show that a duplicate is blocked by the `tradeId` idempotency check on-chain and off-chain.
6. **A copilot that covers all four controls the brief names:** position size, trade frequency, risk appetite, target assets. Every change appears as a typed config diff. Tightening applies immediately. Loosening needs an owner signature.

**Pitch line:** *"Other agents tell you they found an opportunity. Ours proves it: arbitrage that cannot lose money on-chain, and a Guardian that shows why it didn't trade the other 99 times."*

### 1.3 Decision gate (day 1): is atomic arbitrage possible on HSKSwap?
Enumerate every pool from `UniswapV3Factory` `PoolCreated` logs. Atomic arbitrage needs either a **cycle** (for example USDT→WHSK→WETH→USDT) or **the same pair in two fee tiers or two venues**. If none exist with real liquidity:
- **Fallback:** keep the atomic-arbitrage contract path and the scanner, show the scanner reporting "no profitable cycle" honestly, and make CEX-DEX spread the main live strategy.
- Either way, the cycle scanner still runs and logs its results.

---

## 2. Scope: MoSCoW against the 19 stages

| Stage / component | Priority | What we build |
|---|---|---|
| Wallet connection + ownership signature | MUST | wagmi/RainbowKit, SIWE-style signature. Ledger works **through MetaMask or Rabby with a Ledger attached**, so no custom WebHID work |
| Vault (factory + clones) | MUST | EIP-1167 clones: one implementation deploy, cheap vault per user |
| Mandate | MUST | Stored in the vault: per-trade cap, daily volume, daily loss, allowed assets, max exposure per asset, slippage bps, cooldown, expiry, `policyHash` |
| Market monitor | MUST | Pool `slot0`, `liquidity`, `observe` (TWAP), QuoterV2 executable quotes, Swap event flow |
| Data Reliability Engine | MUST | Freshness, cross-source deviation, outliers; outputs VALID, WARNING, WAIT or REJECT |
| AI Strategist | MUST | Deterministic candidate generators, then an LLM picks or abstains with structured output |
| Strategy Filter | MUST | Deterministic checks (conflicting position, stale signal, regime) |
| Sworn Prediction | MUST (small) | Hash committed **in the same tx as the swap** (no extra gas). Not the headline |
| Execution Guardian | MUST (core) | Net-value calculation, liquidity, slippage, simulation |
| Portfolio Risk Manager | MUST | Concentration, total exposure, reservations for in-flight trades |
| Adaptive Execution | SHOULD | Immediate vs split (2 or 3 legs) vs wait, using quotes |
| Atomic arbitrage | MUST (differentiator) | `executeArb(path, amountIn, minProfit, tradeId)` |
| Transaction monitor + recovery | MUST | Nonce manager, tradeId idempotency, reconciliation before retry |
| Evidence / trade history | MUST | Vault events plus off-chain JSON evidence keyed by hash; a "Verify" page |
| Position manager + stop-loss / TP / expiry | MUST | Exits bypass the LLM. **Risk-reducing exits are allowed even after the daily-loss stop** |
| Strategy Health Monitor | SHOULD | Net P&L, win rate, drawdown, Brier, failure rate, auto circuit breaker |
| Emergency controls | MUST | pause, revoke agent, withdraw, tighten; all owner-only on-chain |
| Conversational copilot | MUST | Positions, P&L, the four controls, "why didn't you trade?" |
| Backtest | SHOULD | Replay 30 days of on-chain Swap events through the same Guardian |
| Paper trading / shadow mode | MUST / SHOULD | Same pipeline, different executor (this is just a mode flag) |
| HSP payments | WON'T | Track 2. Mention as future work only |
| Python AI services, BullMQ, microservices, multi-RPC failover, load testing | WON'T | Note them as the production roadmap in the README |

---

## 3. Tech stack (simplified from the document)

| Layer | Choice | Why we changed it |
|---|---|---|
| Contracts | **Solidity 0.8.26 + Foundry** | Fork tests against real HSKSwap pools in seconds. Every serious competitor used Foundry |
| Agent backend | **Node 22 + TypeScript, single service**, modules named as in §7.3 of the document | Keeps the "modular monolith" story without NestJS boilerplate. Use NestJS only if the team already knows it well |
| Chain I/O | **viem** | Typed ABIs, multicall |
| Validation | **zod** | Guards LLM output and API inputs |
| DB | **Postgres (Docker) via Drizzle**, or SQLite for speed | Append-only tables for evidence and trades |
| Jobs | In-process scheduler + a DB-backed lock | Instead of Redis/BullMQ. One keeper process |
| LLM | Anthropic Claude (`claude-sonnet-5-5`) with tool use / JSON schema | Strategist and copilot. The agent still runs on rules alone if the key is missing |
| Frontend | **Next.js + Tailwind + wagmi + Recharts** | Dashboard and copilot chat |
| Realtime | Server-Sent Events | Simpler than WebSockets for one-way feeds |
| Hosting | Agent on a small VPS (Docker); web on Vercel in read-only public mode | A **public live agent page** that judges can open without a wallet |

Monorepo layout:
```
contracts/   src/ test/ script/ deployments/{133,177}.json
agent/       src/modules/{market-data,data-reliability,strategies,ai-strategist,
             predictions,execution-guardian,adaptive-execution,portfolio-risk,
             transactions,recovery,positions,evidence,strategy-health,
             emergency,simulation,copilot}  src/workers/  src/common/
guardian/    separate process + key: validation, portfolio risk, adaptive plan, EIP-712 permit signer
web/         app/{dashboard,agent,execution,portfolio,evidence,health,emergency,simulate,copilot}
research/    pools.md  backtest.md  costs.md
docs/        ARCHITECTURE.md SECURITY.md MAINNET.md DEMO.md
```

---

## 4. Phases

Each phase ends with a deliverable we can demo. Dates assume 1 or 2 developers. With more people, run Phases 2, 3 and 6 in parallel with Phase 1.

### Phase 0: Ground truth and setup (Mon 23 Nov) ✅ DONE (contract-side). See `research/pools.md`
> **Decision gate result:** no real-asset cycles on HSKSwap (star topology around USDT). Tier A stays in the contract but is dormant. The "prove it" headline moves to **Tier B edge-or-revert**.
- [ ] Monorepo, pnpm workspaces, lint, CI (GitHub Actions: `forge test`, `pnpm test`), `.env.example`, `.gitignore` covering keys
- [ ] **Read these from chain; don't copy them from other projects' READMEs:** factory, SwapRouter02, QuoterV2 (two different addresses appear in other submissions, `0x1095…` and `0x603f…`; confirm via `@hskswap/sdk-core`), WHSK, USDT (6 decimals on mainnet), WETH, WBTC, APRO HSK/USD feed
- [ ] Enumerate all HSKSwap pools with liquidity, TVL and 24 h volume, and write `research/pools.md` → **arbitrage decision gate (§1.3)**
- [ ] Measure gas for a swap, a multi-hop swap and a deploy at the current gas price (~500 gwei)
- [ ] Generate keys: owner (hardware wallet via MetaMask), agent (hot key, separate), deployer. Get testnet HSK from the faucet
- **Deliverable:** pool map, address book, cost model, arbitrage go/no-go

### Phase 1: Smart contracts ✅ DONE 23 Nov (ahead of schedule). 73 tests passing (63 unit/fuzz, 4 invariant + liveness, 6 mainnet-fork). Remaining: testnet broadcast + verification, which needs a funded deployer key
`TradingVault` (implementation) + `VaultFactory` (clones):
- [ ] Roles: `owner` (pause, unpause, revoke, setAgent, withdraw, setMandate, tighten), `agent` (swap, arb, exit only)
- [ ] Mandate struct + `policyHash`; `tighten()` is callable by the agent or the owner but can only make limits stricter
- [ ] `swapExactIn(tradeId, tokenIn, tokenOut, fee, amountIn, minOut, predictionHash, reasonHash)`
  - The vault builds the router calldata itself (fixed router, allowlisted pools). **No arbitrary calls**
  - Checks: not paused, agent, not expired, allowed asset, per-trade cap, rolling daily volume, cooldown, exposure cap, `minOut ≥ TWAP-implied floor − slippage` (TWAP via `observe`, not `slot0`)
  - `usedTradeIds[tradeId]` replay protection; exact approve then reset to 0; reentrancy lock
  - Emits `TradeExecuted(tradeId, …, predictionHash, reasonHash)` = the evidence anchor
- [ ] `executeArb(tradeId, path, amountIn, minProfit)`: multi-hop `exactInput`, start token = end token, revert if `balanceAfter − balanceBefore < minProfit`
- [ ] `exitPosition(...)`: risk-reducing sell, **still allowed when the daily-loss limit is hit**, but still bounded by the slippage floor
- [ ] Daily realized-loss accounting vs average cost basis, with UTC-day reset (define it precisely in `SECURITY.md`)
- [ ] **Two-key permits:** EIP-712 `ExecutionPermit` (tradeId, tier, path, amountIn, minOut/minProfit, expectedNetValue, quoteBlock, deadline, policyHash, predictionHash). `swapExactIn` / `executeArb` / `exitPosition` all require a valid Guardian signature. `setGuardian()` is owner-only. Custom errors `InvalidPermit`, `PermitExpired`, `PolicyMismatch`
- [ ] `TradeExecuted` and `PositionClosed` events carry `expectedNetValue` and realized values (Proof of Edge)
- [ ] `anchorDecisions(root, fromSeq, toSeq)`: Merkle root of every decision (APPROVE/WAIT/REJECT), committed every few hours. This replaces `commitHold`
- [ ] Attack tests: agent with no permit, forged permit, replayed permit, permit with a changed amount or route, Guardian key trying to submit on its own
- [ ] Tests: unit (every revert path by name), fuzz/invariants (agent can never withdraw or loosen), **fork tests on real HSKSwap pools** (buy, sell, multi-hop, arb revert)
- [ ] Deploy to testnet (chain 133), verify on Sourcify and Blockscout (keep the standard JSON under ~100 KB; Keel hit HTTP 413 with OpenZeppelin imports)
- **Deliverable:** verified testnet vault, 40+ passing tests. **Freeze the contract ABI on Thursday.**

### Phase 2: Market intelligence ✅ DONE 23 Nov. See `agent/README.md` (25 unit tests + live mainnet test)
- [ ] `market-data`: multicall for slot0, liquidity, TWAP (5 min and 1 h) and QuoterV2 quotes at several sizes (impact curve), for each pool, every N seconds
- [ ] External references: HashKey Global, Gate and MEXC mids for HSK; Binance/OKX for ETH and BTC; APRO HSK/USD (respect its heartbeat)
- [ ] Swap-event indexer: last 24 h of flow, plus backfill of 30 days for the backtest
- [ ] `data-reliability`: freshness thresholds, source deviation, z-score outliers, RPC health. Output VALID, WARNING, WAIT or REJECT with reasons
- [ ] Store `market_snapshots` (append-only)
- **Deliverable:** `GET /api/market/health` showing live reliability per pool

### Phase 3: Strategy and AI ✅ DONE 23 Nov
- [ ] Deterministic candidate generators (these produce the numbers; the LLM never invents prices):
  1. **Atomic cycle arbitrage**: quote every 2- and 3-hop cycle at several sizes, keep it if net > gas + buffer
  2. **CEX-DEX spread**: pool vs reliable reference, only beyond the round-trip fee band
  3. **TWAP mean reversion**: z-score vs 1 h TWAP
- [ ] `ai-strategist`: Claude receives the candidate plus a market and portfolio snapshot and returns `{choose|abstain, size_fraction ≤ 1, probability, target, invalidation, expiry, rationale}`, validated by zod. **It can shrink or skip a candidate. It cannot flip the side, raise the size or invent prices.** Market text is treated as untrusted input (prompt injection)
- [ ] `strategy-filter`: conflicting position, signal age, regime, per-strategy limits
- [ ] `predictions`: canonical JSON → keccak256 → `predictionHash`; store the payload off-chain
- **Deliverable:** proposals with rationale in the DB; shadow mode running against mainnet data

### Phase 4: Execution intelligence / Guardian ✅ DONE 23 Nov. Separate process, verified permit digest, live shadow run
- [ ] `execution-guardian` (pure, deterministic, unit tested): quote freshness, pair match, impact vs depth, slippage vs mandate, fees (2 legs) + gas (in USDT) + exit estimate → **Expected Net Value**, then APPROVE, REJECT or WAIT with a machine-readable reason list
- [ ] `portfolio-risk`: per-asset concentration, total exposure, correlated exposure (ETH/BTC), drawdown, daily loss, **reservations for in-flight trades**
- [ ] `adaptive-execution`: compare 1×N vs 2×N/2 vs 3×N/3 using quotes plus extra gas; WAIT if the spread is widening. Record the comparison table
- [ ] `eth_call` simulation of the exact vault call before signing
- [ ] **Guardian runs as a separate process** (`guardian/` package, its own container and key, small HTTP signing API). The strategist sends proposals and receives either a signed permit or a reasoned REJECT/WAIT. Add a fast path for risk-reducing exits, and a `dryRun` mode used by the copilot's what-if
- **Deliverable:** `POST /api/execution/validate` and `/plan` returning the full decision record, plus signed permits

### Phase 5: Transactions, recovery, positions (Fri 27 – Sat 28 Nov)
- [ ] `transactions`: one nonce manager for the agent key; states SUBMITTED, PENDING, CONFIRMED, FAILED, REPLACED, DROPPED
- [ ] `recovery`: reconcile first (receipt? nonce consumed? `usedTradeIds`? balances changed?), then re-quote and re-validate, retry only with a **new** quote under the **same** tradeId. Retry limits and back-off
- [ ] Balance reconciliation every tick: on-chain vault state is the source of truth, and the DB mirrors it
- [ ] `positions`: average entry and cost basis from real fills, unrealized P&L at the executable exit quote (not mid), target, invalidation, expiry and stop-loss exits that **skip the LLM**
- [ ] `strategy-health`: net P&L after gas and fees, win rate, max drawdown, Brier score (kept separate from P&L), failure rate, slippage vs quote. The circuit breaker calls `pause`/`tighten`
- [ ] RPC failure handling: block new entries, keep monitoring, resume after reconciliation
- **Deliverable:** full loop working on testnet, then on a mainnet fork, with a staged duplicate-submission test

### ⚑ Mainnet go-live (Fri 27 – Sat 28 Nov)
Go live early. A dated history of real mainnet decisions is what won Nalvis and Avow their credibility.
- [ ] Deploy implementation + factory + your vault clone on chain 177, verify, write `deployments/177.json` and `MAINNET.md` with the transaction for every step
- [ ] Fund with small amounts (for example 10–20 USDT plus some WHSK). Owner signs the mandate from the hardware wallet
- [ ] Run **shadow mode for 12 h, then live**. Keep the keeper running until Demo Day

### Phase 6: Dashboard and conversational copilot (Fri 27 – Mon 30 Nov)
- [ ] Pages: Dashboard (vault value, P&L, agent and mandate status), Agent feed (each tick: observation → reliability → candidate → AI → filter → Guardian → risk → plan → tx), Execution, Portfolio, Evidence/Verify, Strategy Health, Emergency, Simulation
- [ ] **Public read-only mode**: anyone can view the live mainnet agent without a wallet
- [ ] Copilot (Claude tool use, typed actions only):
  - Read: `get_positions`, `get_pnl`, `explain_decision(id)`, `why_not_trading`, `market_status`
  - Change: `set_position_size`, `set_trade_frequency`, `set_risk_appetite(low = Tier A, med = A+B, high = A+B+C)`, `set_target_assets`
  - What-if: `what_if(asset, side, amount)` runs the Guardian in dry-run mode against live quotes
  - Every change is shown as a **diff card**. Tighter limits are applied by the agent via `tighten()`. Looser limits produce an owner transaction to sign in the wallet
- **Deliverable:** a judge can type "trade only ETH, smaller, low risk, at most once every 10 minutes" and watch the on-chain mandate change

### Phase 7: Simulation and evidence (Sun 29 – Mon 30 Nov)
- [ ] Backtest: replay 30 days of Swap events and snapshots through the **same** Guardian and risk code, with fees, measured impact and gas. Write `research/backtest.md` with honest results
- [ ] Paper trading: live data, virtual book, fills at quoted output minus modelled impact
- [ ] Strategy comparison view (arbitrage vs spread vs mean reversion)
- [ ] Verifier CLI: `pnpm verify <txHash>` checks the vault event, `predictionHash` vs stored payload, `policyHash` vs mandate, and calldata
- **Deliverable:** Simulation page + `pnpm verify` PASS on a real mainnet trade

### Phase 8: Hardening (Tue 1 Dec), feature freeze at end of day
- [ ] Scenario tests mapped one-to-one to §5 of the project document (scenarios 1–10). Each needs a test name and, where possible, mainnet or fork evidence. Put the mapping table in the README; judges love it
- [ ] Security pass: internal review checklist, slither, `SECURITY.md` with known limits (unaudited, thin liquidity, no proven edge)
- [ ] Stop the copilot from acting without the owner signature; rate-limit the public API

### Phase 9: Submission (Wed 2 Dec)
- [ ] README: one-line pitch, a 3-step "verify it yourself" section, mainnet addresses and tx links, scenario-to-test table, honest scope
- [ ] Demo video (≤ 3 min): the "Try to break it" script in IDEA.md §5 (live agent → arbitrage profit-or-revert → prompt-injection attack rejected → stolen-key call reverts `InvalidPermit` → copilot tighten + what-if → owner pause → verifier PASS)
- [ ] Pitch deck (8–10 slides); DoraHacks BUIDL text; **submit by 20:00 KST on 2 Dec**

### Buffer (3–5 Dec)
- Keep the keeper alive, refresh dated stats, rehearse the live pitch and Q&A, and prepare a fallback recorded demo in case the network fails at the venue

---

## 5. Budget and mainnet gas

At ~500 gwei:

| Item | Gas (est.) | HSK |
|---|---|---|
| Vault implementation deploy | ~2.5 M | ~1.25 |
| Factory deploy | ~0.5 M | ~0.25 |
| Vault clone | ~0.15 M | ~0.08 |
| Swap through vault | ~0.25 M | ~0.12 |
| Multi-hop / arb | ~0.4 M | ~0.2 |

**9 HSK covers the deploys plus about 40–50 trades. That is tight for a week of live running plus failed-arbitrage gas.** HSK trades around 0.08 USDT, so buying another 30–50 HSK costs only a few dollars. Top up the agent before go-live. The keeper stops itself when agent gas drops below 0.2 HSK.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Contract bug found after the mainnet deploy | Freeze on 26 Nov with fork tests; clones let us deploy a v2 implementation cheaply if needed |
| No arbitrage cycles exist on HSKSwap | Decision gate on day 1; fallback to spread and show the scanner's honest negatives |
| Agent never trades because the market is quiet | That is fine and honest; show WAIT reasons. Use small, clearly labelled demo bands for one or two live trades |
| LLM outage or bad output | Rules-only mode; zod rejection; the LLM can only shrink or skip |
| Scope creep | MoSCoW table above; every WON'T item goes in the README roadmap instead |
| Looking like a copy of Nalvis or Avow | Lead with arbitrage, Guardian, recovery and the copilot; credit prior art briefly in the README |
