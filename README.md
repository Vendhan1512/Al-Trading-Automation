# Countersign — the AI trader that can't trade alone

**HSK Chain Horizon Hackathon (Seoul) · Track 1: AI Agent Trading · HashKey Chain + HSKSwap**

An autonomous AI trading agent for HSKSwap in which **no trade can move funds unless an independent committee countersigns it, and the vault on HSK Chain checks every signature.** A stolen agent key, a prompt-injected model or a buggy strategy is not enough to move a single token, and the stop-loss works even when the agent and the committee are offline.

```
AI proposes ─► Execution Guardian prices it ─► Risk Officer re-checks it ─► Vault enforces ─► HSKSwap
   (agent key)        (key #2, signs)              (key #3, co-signs or vetoes)   (k-of-n + mandate)
                                         Owner controls everything (hardware wallet)
```

| | |
|---|---|
| **Two-person rule, on-chain** | Every trade needs *k* of *n* EIP-712 countersignatures from distinct committee keys, checked by the vault. Signatures bind the exact route, size, output floor, edge claim, expected value, prediction and policy. Change the rules or the committee and every outstanding permit dies |
| **Stop-loss that needs nobody** | `stopOut()` is **permissionless**. It triggers on the pool's 30-minute TWAP vs average cost (a one-block wick cannot fire it) and exits with a TWAP-anchored floor (it cannot be sandwiched). Proven on a mainnet fork: a 1.5M WHSK single-block dump did **not** trigger it; the same crash held for 30 minutes did, fired by a stranger |
| **Refuses to lose money on gas** | Entries must carry a committee-signed **positive expected value after fees, impact, exit and gas both ways**. At HSK's 500 gwei a swap costs ~$0.012, so trades under ~3 USDT are refused, by design |
| **Drawdown breaker + re-entry lockout** | NAV valued at TWAP; entries refused below the high-water-mark floor even before anyone trips the breaker; exits always allowed; withdrawals are not mistaken for drawdowns; 1 h lockout after a stop |
| **Honest arbitrage** | The Arbitrage Radar prices every HSK venue (HSKSwap, Hyperindex, WoofSwap, WETH triangles) at executable size. Live result: 150–157 bps gaps exist, but the side pools hold $72–$159, so every route loses before gas. The agent says so instead of pretending |
| **Every decision provable** | Each decision (refusals included) is journaled, hashed and **Merkle-anchored on-chain**. `pnpm verify trade <tx>` re-derives the committee signers from the raw transaction |
| **Mission Control** | Chat covers position size, trade frequency, risk appetite, target assets, stop-loss, take-profit and drawdown, plus "what if I buy 5 USDT of BTC now?" (the real Guardian, dry-run). Stricter changes are applied by the agent; looser ones need the owner's wallet. **Rebalance to USDT**: the signed-in owner asks the agent to convert part of a position; it becomes an EXIT proposal that both committee members must still sign (`POST /api/owner/rebalance`) |

## Verify it yourself (3 minutes, no wallet)
1. **Try to break it.** Open the dashboard's *Try to break it* tab. It runs 15 real attacks against a live v2 vault with `eth_call` from your browser: stolen agent key, forged committee, outsider, guardian submitting, old policy, expired permit, route swap, drain, loosen, rewrite, committee takeover, ownership grab, breaker reset, fake stop-loss. **15/15 blocked**, each with the contract's own revert.
2. **Verify a committee trade.** `cd agent && pnpm verify trade 0x4cbbc0e4a64e95505e3fd92ba43a6f25ed84e04df47d432d95852bd5ea65c24f --testnet` (or any trade hash). It decodes the transaction, recovers both committee signers from the EIP-712 permit, and checks membership, threshold, policy, sender and fill at the previous block: **14/14 PASS**.
3. **Read the contracts.** Verified sources on Blockscout and Sourcify (addresses below).

## Deployments

### HSK Chain mainnet (177)
| Contract | Address | Notes |
|---|---|---|
| CountersignVault v1 implementation | [`0xd195…01BF`](https://hsk.blockscout.com/address/0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF) | Sourcify exact + Blockscout full match |
| VaultFactory v1 | [`0x28ae…fBfE`](https://hsk.blockscout.com/address/0x28ae19424647A051b95944DB26ffC0102085fBfE) | Sourcify exact + Blockscout full match |
| Owner vault (v1) | [`0x76fB…9eE0`](https://hsk.blockscout.com/address/0x76fB3ae6c48964171a297C88a16513284CfB9eE0) | created by the owner's wallet |
| **CountersignVault v2 implementation** | [`0x0728…1098`](https://hsk.blockscout.com/address/0x0728B021D518a916edC1dc7689d6fBD23d601098) | committee + permissionless stops · Sourcify exact + Blockscout full match |
| **VaultFactory v2** | [`0x564a…6af4`](https://hsk.blockscout.com/address/0x564ae60993717fF696c6E261F3CD7d4Ee9c56af4) | Sourcify exact + Blockscout full match |
| **Owner vault v2 (live)** | [`0x5c13…2030`](https://hsk.blockscout.com/address/0x5c13500A4aD4277a13C7d774a78Cfd267A202030) | 2-of-2 committee · **15/15 attacks blocked on mainnet** |

### HSK Chain testnet (133), v2
| Contract | Address |
|---|---|
| CountersignVault v2 implementation | [`0xC5364E26d793e9745F095018B7288b8ED3112D4B`](https://testnet-explorer.hskchain.net/address/0xC5364E26d793e9745F095018B7288b8ED3112D4B) |
| VaultFactory v2 | [`0xFe19ba9E01aeE243869DfBEFA7B423B13F645779`](https://testnet-explorer.hskchain.net/address/0xFe19ba9E01aeE243869DfBEFA7B423B13F645779) |
| 2-of-2 committee vault | [`0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1`](https://testnet-explorer.hskchain.net/address/0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1) |

On that vault, with real transactions: the agent's self-signed permit was refused (`InvalidPermit`), the Guardian alone was refused (`NotEnoughSignatures(1, 2)`), and the 2-of-2 committee-signed trade executed. Full list in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

Roles: agent `0x1709…bEA7` · Execution Guardian `0xE278…ac5D` · Risk Officer `0x2697…6E29` · owner `0x5bb8…4208`.

## The 10 scenarios from the design, and where each is proven
| Scenario | Behaviour | Proof |
|---|---|---|
| 1. False opportunity (stale quote) | Stale/wide/crossed/outlier sources excluded; no reliable reference → WAIT | `agent/test/engine.test.ts` "Scenario 1"; live verdict excludes HashKey Global's 1729/2130 ETH book |
| 2. Low liquidity | Impact above the limit → REJECT; Risk Officer is stricter (30 vs 50 bps) | `guardian.test.ts` "Scenario 2", `v2.test.ts` |
| 3. Slippage changes before execution | TWAP floor + router minimum → revert, never a silent bad fill | `test_Revert_RouterMinOutWhenMarketMoves`, fork `TwapFloorRejectsWorthlessMinOut` |
| 4. Duplicate submission | Blocked locally and on-chain (`usedTradeIds`) | `phase5.test.ts` "Scenario 4", `test_Attack_ReplayTradeId` |
| 5. AI exceeds its mandate | Guardian REJECT; vault `TradeTooLarge` | `guardian.test.ts` "Scenario 5", `testFuzz_CapAlwaysEnforced` |
| 6. Daily loss limit | Entries stop, exits continue, UTC reset | `test_DailyLoss_BlocksEntries_AllowsExits_ResetsNextDay` |
| 7. Strategy deteriorates | Circuit breaker: the agent pauses or tightens its own vault; NAV drawdown breaker on-chain | `phase5.test.ts` "Scenario 7", `test_Breaker_*` |
| 8. Owner revokes the agent | `setAgent(0)`; permissionless stops keep working | `test_RevokeAgent`, `test_StopLoss_WorksWithAgentRevokedAndVaultPaused` |
| 9. RPC failure | Market REJECT, no state changes, reconcile before resuming | `engine.test.ts` "Scenario 9", `phase5.test.ts` "RPC down" |
| 10. Prediction is wrong | Sworn prediction graded INVALIDATED (write-once); exit; Brier tracked separately from P&L | `phase5.test.ts` grading tests |

## Architecture
- `contracts/`: Solidity 0.8.26 / Foundry. `CountersignVault` (k-of-n permits, mandate, TWAP floors, permissionless stops, breaker, anchoring), `VaultFactory` (EIP-1167 clones). **95 tests**: 63 unit, 20 v2, 4 invariants with a liveness check, 8 on a mainnet fork against the real HSKSwap pools.
- `agent/`: TypeScript / viem. Market data + Data Reliability Engine → deterministic candidates (Tier A arbitrage scanner, Tier B spread, Tier C mean reversion) → Strategy Filter → **Claude** strategist (may only take, shrink or skip; rules-only fallback) → sworn prediction → **Execution Guardian** (process + key #2) → **Risk Officer** (process + key #3, optional Claude veto) → transaction manager with reconcile-first recovery → keeper (stops, breaker) → strategy health → Merkle anchoring. **112 unit tests + 2 live tests.**
- `ui/`: the dashboard. React 19 + TypeScript + Tailwind v4 + Motion, shadcn-style `src/components/ui/`. Hand-drawn SVG stages with real physics: the **Vault Pour** (your vault as a glass jar filled with its live holdings; a stop-loss knocks it off the stage), the **Countersign Stage** (a permit collects the Guardian's and the Risk Officer's wax seals, or is knocked off with the vault's real revert), the **Break-It Arena** (15 live `eth_call` attacks fired at the vault, `?run=1` to start on load), a decision **heartbeat**, and Mission Control. Works against the live agent or the published snapshot; `pnpm --filter @countersign/ui dev` proxies `/api` to the agent. The Vault Pour interaction is inspired by Aakash Mehra's Coffee Pour Menu.
- `web/`: the snapshot data (`web/data/`, written by `pnpm publish-site`) and the original dependency-free dashboard, served as a fallback when `ui/dist` isn't built.
- `tools/owner-console/`: the owner's wallet page (create vault, deposit, pause, revoke, withdraw).
- `research/`: [pools.md](research/pools.md) (venue measurements) and [backtest.md](research/backtest.md) (30-day replay of the live rules).

## What the backtest taught us
30 days of real HSKSwap swaps (2,750) and exchange candles, live defaults, **nothing tuned**:

| Policy | WHSK | WETH | WBTC | Total (USDT) |
|---|---|---|---|---|
| Rules alone (no gate) | −1.82 | −2.81 | −2.38 | **−7.00** |
| First Guardian (valued entries at full gap convergence) | −0.80 | −1.80 | −1.72 | **−4.32** |
| **Fixed Guardian (values entries at the strategy's own half-gap exit)** | **−0.07** | **+0.08** | **−0.64** | **−0.63** |

The replay exposed a real flaw: the first Guardian assumed the whole gap would close while the strategy only targets half of it, so it approved trades whose own target couldn't pay two pool fees plus gas. After the fix the gate refuses about 99% of candidates and **cuts losses by 91%**. This does not prove a profitable edge, and we don't claim one. It shows the committee refuses most trades that can't pay their costs. WBTC still loses (its pool sits ~240 bps under the exchanges for hours), so we report that honestly rather than tune a filter to the same data.

## Run it
```bash
pnpm install
cd contracts && forge test && cd ..                 # contracts (fork tests need network access)
pnpm --filter @countersign/agent test               # agent
pnpm --filter @countersign/agent guardian           # terminal 1 — Execution Guardian (GUARDIAN_PK only)
pnpm --filter @countersign/agent risk               # terminal 2 — Risk Officer (RISK_OFFICER_PK only)
pnpm --filter @countersign/agent agent              # terminal 3 — agent (AGENT_PK only), dashboard at http://localhost:8787
```
Each process loads only its own key from `.env` and refuses to start if another role's key is visible. `AGENT_MODE=live VAULT=0x…` turns on trading.

## Honest limits
- Unaudited hackathon code. Sizes are deliberately tiny.
- On this deployment the three keys run as separate processes on one host. Production would put the committee in HSMs or with independent operators (the owner can rotate it).
- HSKSwap's real liquidity is a star around USDT, so on-chain cycle arbitrage (Tier A) is dormant. Spread trades (Tier B) carry price risk between entry and exit.
- We claim **no sustained profitability**. We claim the AI cannot act alone, and every edge claim is committed and checkable.
- HSP (Track 2) is not integrated.

🤖 Built with [Claude Code](https://claude.com/claude-code).
