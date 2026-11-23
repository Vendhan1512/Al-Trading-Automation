# Security model and known limits

> **Unaudited hackathon prototype.** Sizes on mainnet are deliberately tiny. Do not deposit funds you are not prepared to lose.

## Trust boundaries
| Compromised component | What an attacker can do | What they cannot do |
|---|---|---|
| LLM (prompt injection, hallucination) | Propose bad trades | Get any trade the Guardian rejects onto the chain |
| Agent key | Submit Guardian-approved permits early or not at all; `pause`; `tighten`; anchor junk decision roots | Trade without a Guardian signature; loosen; withdraw; unpause; change roles |
| Guardian key | Sign permits | Submit them (only the agent can); withdraw; loosen |
| Agent **and** Guardian keys | Trade within the mandate: caps, daily volume, daily loss, exposure, TWAP floor, allowed assets and tiers, expiry | Exceed the mandate; withdraw; change roles |
| Owner key | Everything | — The owner key belongs on a hardware wallet or Safe |

## Design decisions
- **No arbitrary calls.** The router is immutable in the implementation. The vault builds the `exactInput` call itself, and the recipient is always the vault.
- **Permits are fully bound.** They cover the route, size, minimum output, reference output, expected value, prediction and decision hashes, current policy, deadline, chain ID and vault address. Changing any field invalidates the signature.
- **Policy invalidation.** Every `setMandate` or `tighten` bumps `policyNonce`, which changes `policyHash`, which invalidates all outstanding permits.
- **Exits are never trapped.** Sells of tracked inventory ignore `paused`, cooldown, caps and the daily-loss stop. They still require a permit and still respect the TWAP floor. The Guardian service has a fast path for these.
- **TWAP, not spot, for the floor.** We use a 30-minute arithmetic-mean tick on mainnet. The trade-off is that legitimate trades revert when spot moves more than about `maxSlippageBps` away from the TWAP. In a fast market that is the safe failure.
- **Daily loss** is *net realized* P&L for the current UTC day, in quote units. Unrealized losses do not stop entries on-chain. The off-chain risk manager and circuit breaker cover those and can `pause` or `tighten`.
- **Exposure** is measured by cost basis, which needs no oracle. A position that has appreciated can exceed the nominal cap in market value.

## Known limits
1. **Guardian independence.** In the hackathon deployment the Guardian runs as a separate process with a separate key, but on the same host as the agent. Production should put it in an HSM or KMS, or with an independent operator. `setGuardian` supports rotation.
2. **Tier B reference.** `refAmountOut` comes from off-chain exchange prices and is attested by the Guardian; the contract cannot verify it. The contract does enforce that the fill beats it by `minEdgeBps`, and it records it on-chain for later grading.
3. **Tier A** has no real cycles on HSKSwap today (see `research/pools.md`). The path is live, tested on a fork, and dormant.
4. **Cost-basis accounting** ignores gas. Gas is reported separately off-chain in net P&L.
5. **Revocation** cannot cancel a transaction that has already been mined. Pending agent transactions with valid permits may still land. Pausing first, then revoking, minimises the window.
6. **Explorer verification** works for the implementation and factory. Clones are recognised as EIP-1167 proxies.
7. **Tests are not an audit.** The suite covers 67 unit, fuzz and invariant tests plus 6 mainnet-fork tests, but it is not a security review.
