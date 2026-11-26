# Demo video script (2:50) and pitch outline

**Title card (0:00–0:08):** *Countersign — the AI trader that can't trade alone.* HSK Chain · HSKSwap · Track 1.

## 1. The problem (0:08–0:25)
Voice: "Every AI trading agent here asks you to trust one key. If the model is tricked, or the key is stolen, the money moves. And if the bot is offline in a crash, the stop-loss never fires."
Screen: the four-role strip at the top of the dashboard.

## 2. The two-person rule (0:25–0:55)
Voice: "Countersign applies the two-person rule to AI money. The agent proposes. An Execution Guardian prices the trade and signs. An independent Risk Officer re-checks everything with its own data and co-signs or vetoes. The vault on HSK Chain only executes with both signatures, inside the owner's mandate."
Screen: Agent feed → open a decision → Guardian checks ✓/✕, Risk Officer verdict, expected net value after gas.

## 3. Try to break it (0:55–1:25)
Voice: "Don't trust us. Attack it."
Screen: *Try to break it* → **Run all attacks** → 15 rows go 🛡 BLOCKED: stolen agent key `InvalidPermit`, no countersignature `NotEnoughSignatures(0, 2)`, forged committee, drain `NotOwner`, loosen `NotTighter`, fake stop-loss `StopNotTriggered`.
Voice: "Fifteen real attacks against the live contract, from your browser, no wallet, no gas. Fifteen blocked."

## 4. The stop-loss that needs nobody (1:25–1:50)
Screen: terminal `forge test --match-path test/fork/*` → the two stop tests.
Voice: "On a fork of HSK mainnet, a whale dumps 1.5 million WHSK in one block. The stop does not fire: it reads the 30-minute TWAP, so a wick can't trigger it. Hold the crash for 30 minutes and a random stranger fires it. No agent, no committee needed."

## 5. Honest economics (1:50–2:20)
Screen: Arbitrage radar card; then `research/backtest.md` table.
Voice: "Arbitrage: WoofSwap trades 157 basis points above HSKSwap. But that pool holds 84 dollars, and every route loses before gas. We show it rather than pretend. Our 30-day backtest found a flaw in our own Guardian. Fixing it cut losses by 91% against rules alone. We claim no profit. We claim the agent can't trade alone and refuses to lose money on gas."

## 6. Mission Control (2:20–2:40)
Screen: chat → "Low risk, only trade ETH and BTC, stop loss 2%" → diff card → owner signs in → "applied via tighten()". Then "What if I buy 5 USDT of BTC now?" → Guardian dry-run verdict.

## 7. Verify (2:40–2:50)
Screen: `pnpm verify trade 0x4cbb…c24f --testnet` → **VERIFIED — 14/14**.
Voice: "Every trade, re-derived from the chain. Countersign."

---

## Pitch deck outline (8 slides)
1. **Countersign**: the AI trader that can't trade alone (one line + the four-role diagram)
2. **Problem**: one key, one model, one bot online = one point of failure (three failure modes)
3. **Two-person rule on-chain**: k-of-n EIP-712 committee; what each role can and cannot do (table)
4. **Liveness without trust**: permissionless TWAP stop-loss and drawdown breaker (fork proof numbers)
5. **Try to break it**: 15/15 attacks blocked (screenshot)
6. **Honest economics**: arbitrage radar and backtest table (−7.00 → −0.63 USDT; the flaw we found)
7. **Mission Control and evidence**: chat diff cards, Merkle anchoring, `pnpm verify` 14/14
8. **Status and asks**: mainnet and testnet addresses, 208 tests, limits, roadmap (HSM committee, HSP-paid guardians, more venues)
