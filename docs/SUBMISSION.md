# DoraHacks submission: Countersign

**Track:** 1 · AI Agent Trading · HSK Chain + HSKSwap
**Repo:** https://github.com/Vendhan1512/Al-Trading-Automation
**Live dashboard:** https://vendhan1512.github.io/Al-Trading-Automation/ <!-- confirm after Pages run -->
**Demo video:** _link_

## One line
Countersign is the AI trader that can't trade alone. Claude proposes each trade, a 2-of-2 committee countersigns it, and a vault on HSK Chain checks every signature before any token moves.

## Problem
Most AI trading agents run on a single hot key. Three things can go wrong:
- A prompt-injected model can move the money.
- A stolen key can move the money.
- If the bot is offline during a crash, the stop-loss never fires.

## What we built
- **Two-person rule, on-chain.** Every trade needs k-of-n EIP-712 countersignatures. Each one is bound to the exact route, size, output floor, expected value and policy. An Execution Guardian and an independent Risk Officer each run their own process, key and data. Claude Opus 5.5 is the strategist, and its proposals must pass both.
- **A stop-loss that needs nobody.** `stopOut()` is permissionless and reads the 30-minute TWAP. On a mainnet fork, a 1.5M WHSK single-block dump did not trigger it. The same crash held for 30 minutes did, and it was fired by a stranger.
- **Refuses to lose money on gas.** An entry needs a committee-signed positive net value after fees, price impact, the exit and gas both ways. There is also a NAV drawdown breaker and a re-entry lockout.
- **A mandate that only tightens.** The agent or the committee can make the rules stricter. Only the owner's wallet can loosen them.
- **Provable.** Every decision, including refusals, is Merkle-anchored on-chain. `pnpm verify trade <tx>` re-derives the committee signers from the raw transaction (14/14 checks).
- **Try to break it.** 15 real attacks run against the live vault from any browser, with no wallet. All 15 are blocked.
- **Honest economics.**
  - The Arbitrage Radar shows that the 150–157 bps cross-venue gaps sit in $72–$159 pools, so they don't pay.
  - A 30-day backtest found a flaw in our own Guardian. Fixing it cut losses by 91%.
  - We claim safety, not profit.

## Proof on HSK mainnet (chain 177)
| | |
|---|---|
| CountersignVault v2 | `0x0728B021D518a916edC1dc7689d6fBD23d601098` (Sourcify exact + Blockscout full) |
| VaultFactory v2 | `0x564ae60993717fF696c6E261F3CD7d4Ee9c56af4` (Sourcify exact + Blockscout full) |
| Owner's 2-of-2 vault | `0x5c13500A4aD4277a13C7d774a78Cfd267A202030` (15/15 attacks blocked on mainnet) |
| First countersigned trade | _tx_ |
| Decision anchor #0 (475 decisions, one Merkle root) | `0x9ad3ce936fadc559d92351ff835e35f74e8696b835ba1b72ead827771f21dea7` · `pnpm verify decision 474` → VERIFIED 3/3 |
| Keeper `checkBreaker` (high-water mark) | `0x896f69019e99cb4f0fa13a7fe7b846f0ad52adcf1d16a172f13b1902ba43879e` |

**Tests:** 101 contract tests (unit, v2, invariants, mainnet-fork) and 113 agent tests.

## How to judge it in 3 minutes
1. Open the dashboard and go to **Try to break it**. Press **Run all**. All 15 attacks should be blocked.
2. Run `cd agent && pnpm verify trade <mainnet tx>`. It should report **VERIFIED**.
3. Read the verified contracts on Blockscout.

## Limits
- Unaudited, with deliberately tiny sizes.
- In this deployment, the committee keys run on one host. In production they would sit in HSMs or with independent operators.
- No HSP integration.
