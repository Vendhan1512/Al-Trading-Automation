# Security model and known limits (v2)

> **Unaudited hackathon prototype.** Mainnet sizes are deliberately tiny. Do not deposit funds you are not prepared to lose.

## Trust boundaries
| Compromised component | What an attacker can do | What they cannot do |
|---|---|---|
| LLM (prompt injection, hallucination) | Propose bad trades | Get any trade the committee rejects onto the chain. The model only takes, shrinks or skips rule-made candidates, and every bound is re-enforced in code |
| Agent key | Submit committee-approved permits early or not at all; `pause`; `tighten`; anchor junk roots; pay gas for `stopOut` / `checkBreaker` | Trade without *k* committee signatures; loosen; withdraw; unpause; change the committee or owner |
| One committee key (k = 2) | Sign permits | Reach the threshold alone (`NotEnoughSignatures`); submit trades; withdraw; loosen |
| Agent **and** every committee key | Trade *within* the mandate: caps, daily volume and loss, exposure, cooldown, TWAP floor, edge, positive expected value, drawdown breaker, re-entry lockout, allowed assets and tiers, expiry | Exceed the mandate; withdraw; change roles |
| Owner key | Everything | — The owner key belongs on a hardware wallet or Safe |
| Nobody online (agent and committee down) | — | Stop the stop-loss: `stopOut()` and `checkBreaker()` are permissionless |

## Design decisions
- **k-of-n countersignatures.** Signatures must recover to distinct registered guardians in strictly increasing address order, so one signature cannot be counted twice. The committee is part of `policyHash`, so changing it invalidates every outstanding permit.
- **No arbitrary calls.** The router is immutable. The vault builds `exactInput` itself and the recipient is always the vault. Single-hop trades must use the asset's registered fee tier.
- **Fully bound permits.** Each permit binds the route, size, minimum output, reference output, expected value, prediction and decision hashes, policy, deadline, chain ID and vault address.
- **Entries must expect a profit.** The committee signs `expectedNetValue`, which must be greater than 0 (or the mandate floor). The Guardian values entries at the strategy's own exit (half the gap), after exit fee, impact and gas both ways. This followed a backtest finding; see `research/backtest.md`.
- **Permissionless stops.** The trigger is the pool's TWAP value of the position against its average cost. The exit floor is `TWAP-out × (1 − fee) × (1 − maxSlippage)`: a single-block wick can neither fire the stop nor be sandwiched into it. This was proven on a mainnet fork against the real pool. Partial exits let thin pools be unwound in steps. A stop locks re-entry into that asset for 1 hour.
- **Drawdown breaker.** NAV is valued at TWAP. Entries revert below `highWaterMark × (1 − maxDrawdown)` even before anyone calls `checkBreaker()`. Exits are never blocked. Withdrawals rescale the mark. Only the owner can reset it.
- **Exits are never trapped.** Sells of tracked inventory ignore pause, cooldown, caps, the daily-loss stop and the breaker, but still need the committee (or the permissionless stop) and still respect the TWAP floor.
- **Off-chain defense in depth.** Three processes with three keys. Each loads only its own secret and refuses to start if another role's key is visible. A test forbids any runtime import of a committee member from agent code. The Risk Officer re-derives everything independently and simulates the full committee transaction before co-signing.

## Known limits
1. **Committee independence.** In this deployment the Guardian and Risk Officer are separate processes and keys on one host. Production should use HSMs or KMS, or independent operators. `setCommittee` supports rotation.
2. **Tier B reference.** The reference price is off-chain (an exchange median) and attested by the committee. The contract enforces that the fill beats it by `minEdgeBps` and records it on-chain for grading.
3. **Tier A** has no real-liquidity cycles on HSK today. The Arbitrage Radar measures every venue and reports it.
4. **Spread trades carry price risk** between entry and exit. The backtest shows the fixed gate cuts losses by 91% against rules alone, not a proven edge.
5. **Revocation** cannot cancel an already-mined transaction. Pause, then revoke, to minimise the window.
6. **Tests are not an audit:** 95 contract tests (incl. invariants and mainnet-fork) and 113 agent tests.
