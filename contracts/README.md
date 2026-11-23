# Countersign contracts

Solidity 0.8.26 · Foundry · HSK Chain (mainnet 177, testnet 133) · HSKSwap (Uniswap V3)

| Contract | Purpose |
|---|---|
| `src/CountersignVault.sol` | Per-owner vault. Executes only **agent-submitted, Guardian-countersigned** trades that pass the owner's mandate |
| `src/VaultFactory.sol` | Deploys a vault per user as an EIP-1167 clone of one verified implementation |
| `src/libraries/Utils.sol` | SafeToken, ECDSA (EIP-2 malleability check), Clones. No OpenZeppelin, which keeps the verification JSON small |
| `src/libraries/TickMath.sol`, `FullMath.sol` | Uniswap v3-core `0.8` branch, unmodified (GPL-2.0-or-later / MIT) |
| `script/Addresses.sol` | Mainnet addresses verified on-chain (see `../research/pools.md`) |
| `script/Deploy.s.sol` | `Deploy` (implementation + factory) and `CreateVault` (owner, intended for `--ledger`) |

## Roles: the AI can't trade alone
| Role | Can | Cannot |
|---|---|---|
| **Owner** (Ledger / Safe) | `setMandate`, `unpause`, `setAgent` (0 = revoke), `setGuardian`, `withdraw`, `depositAsset`, two-step ownership transfer | — |
| **Agent** (AI hot key) | `execute` *with a valid permit*, `anchorDecisions`, `tighten`, `pause` | trade without a Guardian signature; loosen the mandate; withdraw; unpause |
| **Guardian** (separate key) | sign EIP-712 `ExecutionPermit`s, `tighten`, `pause` (circuit breaker) | submit trades; withdraw; loosen; unpause |

Roles must be three distinct addresses. Ownership cannot be transferred to the agent or the Guardian.

## What `execute(path, permit, sig)` enforces
1. The caller is the agent; the mandate has not expired; the permit deadline has not passed.
2. `tradeId` has never been used (idempotency and replay protection for Smart Trade Recovery).
3. `keccak256(path) == permit.pathHash`; `permit.policyHash == policyHash` (any mandate change invalidates outstanding permits).
4. The EIP-712 signature recovers to the **Guardian**. The domain binds chain ID and vault address, so a permit for one vault cannot be used on another.
5. Every token is the quote token or a registered asset; intermediate hops must be allowed assets.
6. Route kind is derived from the path:
   - **BUY** (quote→asset, 1 hop): not paused, tier B or C enabled, asset allowed, `amountIn ≤ maxTradeQuote`, cooldown, daily loss not reached, daily volume, per-asset exposure (cost basis), TWAP floor; tier B **edge-or-revert** (`minOut ≥ ref × (1 + minEdgeBps)`); tier C needs a `predictionHash`.
   - **SELL** (asset→quote, 1 hop): only *tracked* quantity, TWAP floor. **Allowed while paused and after the daily-loss stop**, so a stop-loss is never trapped.
   - **ARB** (quote→…→quote, ≤ 4 hops, tier A): entry checks, `minOut ≥ amountIn + minArbProfit`, and the balance must increase. **Profit or revert.**
7. Exact approval to the router, reset to 0 afterwards. Input must equal `amountIn` exactly (fee-on-transfer tokens are rejected). Reentrancy lock.
8. Emits `TradeExecuted(tradeId, tier, kind, …, refAmountOut, expectedNetValue, realizedPnl, predictionHash, decisionHash)`. This is the on-chain half of Proof of Edge.

**TWAP floor:** `minOut ≥ TWAP-out × (1 − fee) × (1 − maxSlippageBps)`, using the pool's `observe()` over `twapWindow`: 30 minutes on mainnet, where pools have 240 observation slots. A single manipulated block cannot drag the floor.

**Accounting:** per-asset quantity and average cost basis in quote units. Realized P&L is booked on sells and arbitrage. Daily stats reset at 00:00 UTC. Entries stop once today's net realized loss reaches `dailyLossQuote` (a cap of 0 means any loss stops entries). Owner deposits through `depositAsset` are valued at TWAP. Plain transfers are untracked: the owner can withdraw them, but the agent cannot sell them.

**Decision anchoring:** `anchorDecisions(root, fromSeq, toSeq)` commits a Merkle root of every off-chain decision (APPROVE, WAIT, REJECT), with contiguous, gap-free sequence ranges.

## Tests
```bash
forge test                                # 67 unit + fuzz + invariant tests (mocks, offline)
forge test --match-path "test/fork/*" -vv # 6 tests on a fork of HSK mainnet: real router, pools, tokens
```
| Suite | Covers |
|---|---|
| `CountersignVault.t.sol` (63) | Every revert path by name; two-key attacks (self-signed permit, attacker permit, Guardian submitting, owner submitting, tampered amount, minOut or path, replay, cross-vault permit, malleable signature, reentrancy through the router); caps, volume, exposure, cooldown, TWAP floor, edge, tiers, assets, expiry, policy invalidation; sells and P&L; exits while paused; daily-loss stop and UTC reset; arbitrage profit-or-revert; revoke; Guardian rotation; tighten-only; owner-only admin; withdraw tracking; deposit valuation; two-step ownership; anchoring; fuzz tests |
| `Invariants.t.sol` (4 + liveness) | Random sequences of legitimate and hostile calls (owner never acts): funds leave only to the router or the owner; roles never change; the mandate never loosens; exposure caps hold and tracked quantities stay backed by balances; legitimate trades still execute |
| `fork/MainnetFork.t.sol` (6) | Real BUY and SELL of WHSK (2 USDT → 24.68 WHSK → 1.988 USDT), WETH and WBTC buys, TWAP floor rejection, arbitrage cycle reverting on the real router with principal untouched, stolen agent key, full owner exit |

Measured on the fork: `execute` uses **205 k – 284 k gas** (~0.10–0.14 HSK at 500 gwei).

## Deploy
```bash
# 1) implementation + factory (testnet first)
forge script script/Deploy.s.sol:Deploy --rpc-url hsk_testnet --broadcast --private-key $DEPLOYER_PK
# mainnet: CONFIRM_MAINNET=yes forge script ... --rpc-url hsk_mainnet --broadcast ...

# 2) the owner creates the vault (Ledger signs)
AGENT=0x.. GUARDIAN=0x.. forge script script/Deploy.s.sol:CreateVault \
  --rpc-url hsk_mainnet --broadcast --ledger --sender <LEDGER_ADDRESS>

# 3) verify (Sourcify)
forge verify-contract <IMPL> src/CountersignVault.sol:CountersignVault --chain 177 --verifier sourcify \
  --constructor-args $(cast abi-encode "c(address,address)" 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3 0x972cA9D1662F5e029cD18327D29026532E84c742)
forge verify-contract <FACTORY> src/VaultFactory.sol:VaultFactory --chain 177 --verifier sourcify \
  --constructor-args $(cast abi-encode "c(address)" <IMPL>)
```
Clones are EIP-1167 proxies of the verified implementation, which explorers resolve automatically. Deployment records are written to `deployments/<chainId>.json`.

Fund the vault: transfer USDT to the vault address. To hand existing WHSK, WETH or WBTC to the agent with a cost basis, use `approve` plus `depositAsset`.

See [`../docs/SECURITY.md`](../docs/SECURITY.md) for the trust model and known limits.
