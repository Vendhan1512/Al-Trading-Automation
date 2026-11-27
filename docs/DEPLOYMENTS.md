# Deployments

## Roles
| Role | Address |
|---|---|
| Owner (user wallet) | `0x5bb83E60a7a05A0e1b077B66412a26306e334208` |
| Agent (AI hot key; also deployed the ownerless implementation and factory) | `0x170912F2F8beb252902e9b07F63851B2e284bEA7` |
| Guardian (countersigner) | `0xE278AC403F93b05cad73f6C3C4D0B9E5667fac5D` |

## HSK testnet (chain 133), v2 — committee + permissionless stops (26 Nov 2026)
| Contract | Address |
|---|---|
| CountersignVault v2 implementation | [`0xC5364E26d793e9745F095018B7288b8ED3112D4B`](https://testnet-explorer.hskchain.net/address/0xC5364E26d793e9745F095018B7288b8ED3112D4B) |
| VaultFactory v2 | [`0xFe19ba9E01aeE243869DfBEFA7B423B13F645779`](https://testnet-explorer.hskchain.net/address/0xFe19ba9E01aeE243869DfBEFA7B423B13F645779) |
| 2-of-2 committee vault (E2E) | [`0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1`](https://testnet-explorer.hskchain.net/address/0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1) |

| Deploy step | Transaction |
|---|---|
| CountersignVault | `0x2322b4c93322f8e3204a26a528bf5af48547b28fe0bd9feed85c718bb965c857` |
| VaultFactory | `0x9f1244c498165136ef1aa50f0327d6d6e9f36b31dc3fafd22ce5fd462ebd0ee8` |

End-to-end run (`script/E2ETestnet.s.sol`), committee = Execution Guardian `0xE278…ac5D` + Risk Officer `0x2697…6E29`, threshold 2. The agent's self-signed permit was refused (`InvalidPermit`) and the Guardian alone was refused (`NotEnoughSignatures(1, 2)`); both were simulated with no gas. The committee-signed trade executed:

| Step | Transaction |
|---|---|
| createVault | `0x251b5e33f2c08203bc6be7b4a1d8ed7a0a315dea8cb0d86c6f86e4fb011c4354` |
| deposit | `0x51976927f8a169fa789369a12201c05a75bab9939dd68ff91c1e726172338f1b` |
| approve | `0x588be9b9539b927b21843f2ca335a4a218de53d105bc2b2ffa9c1a99c93b6c52` |
| depositAsset | `0x802933b241ee92fb3a49aed10dbee6d676a292619851406ccad4a86fb92e1ce6` |
| execute | `0x4cbbc0e4a64e95505e3fd92ba43a6f25ed84e04df47d432d95852bd5ea65c24f` |

`pnpm verify trade <execute tx> --testnet` → **14/14 PASS**.

## HSK testnet (chain 133), v1 — deployed 23 Nov 2026
| Contract | Address | Verification |
|---|---|---|
| CountersignVault (implementation) | [`0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF`](https://testnet-explorer.hskchain.net/address/0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF) | Sourcify **exact_match** |
| VaultFactory | [`0x28ae19424647A051b95944DB26ffC0102085fBfE`](https://testnet-explorer.hskchain.net/address/0x28ae19424647A051b95944DB26ffC0102085fBfE) | Sourcify **exact_match** |

Deploy transactions: implementation `0xdf19765959304cda2111098272326a928bbb19560e728f2c00fdd3343a537f1c` (3,863,337 gas) and factory `0xca74a1639ada30d4f1dcef21e41ede03e6d31e597ab4bb05851540378c38852a` (626,376 gas).

### Owner's testnet vault
`0xB1C5bAf8E167d10e0d15ba5d6e7Ad814c2A7F715`, created by the owner wallet through the Owner Console. It is used for agent development.

### End-to-end two-key run on testnet (`script/E2ETestnet.s.sol`)
These are real transactions. A throwaway *test* owner `0xcD0181a00883ad99f1ddb6BDFdb095328Dd1e87A` was used so the user's wallet never had to share a key.

| Step | Transaction | Result |
|---|---|---|
| Test owner creates vault `0x76fB3ae6c48964171a297C88a16513284CfB9eE0` | `0x4c48fde1acc01f18732599e3e7e25bd91d25260175457218ebb7f46f2a0a158c` | 554,374 gas |
| Wrap 0.01 HSK → WHSK | `0x713c6e071b9d703bf681c6a7d55d3b81d5876c40f2885b394f4be0c18263265c` | ok |
| Approve | `0xe28005bfc5509dbd3b029db2053b0482e877c35ea47479d32be04784cbb90167` | ok |
| `depositAsset` (TWAP cost basis) | `0x943fb31ffdedb791eb92942c8c583fe64a95575008bbbb3f2876f34b39a77a02` | ok |
| Agent + **self-signed** permit | simulated, not broadcast | **refused: `InvalidPermit()`** |
| Agent + **Guardian-countersigned** SELL 0.005 WHSK | `0x1e7a840a233ec2c207ecee0372a79575bdf5b96ba0594c470843a4cff67fd4d0` | **executed**, 274,834 gas, 0.27 test-USDT out |

Testnet pool prices are not real prices. This run proves the mechanics, not profitability.

## HSK mainnet (chain 177), v2 — deployed 26 Nov 2026 ✅
| Contract | Address | Verification |
|---|---|---|
| CountersignVault v2 implementation | [`0x0728B021D518a916edC1dc7689d6fBD23d601098`](https://hsk.blockscout.com/address/0x0728B021D518a916edC1dc7689d6fBD23d601098) | Sourcify **exact_match** · Blockscout **full match** |
| VaultFactory v2 | [`0x564ae60993717fF696c6E261F3CD7d4Ee9c56af4`](https://hsk.blockscout.com/address/0x564ae60993717fF696c6E261F3CD7d4Ee9c56af4) | Sourcify **exact_match** · Blockscout **full match** |

| Step | Transaction | Block | Gas |
|---|---|---|---|
| Deploy v2 implementation | [`0x49d207b0…bcf3c`](https://hsk.blockscout.com/tx/0x49d207b08df8e12d33df115621b102c43e78c695a6288bf393556a76172fdc5c) | 30,684,094 | 5,003,266 |
| Deploy v2 factory | [`0x119e1a63…cf3c`](https://hsk.blockscout.com/tx/0x119e1a6366a7cb58dd3e2d3ab46a68c7c0aa7f166eec118f865c23030f9bcf3c) | 30,684,096 | 692,460 |

### Owner's v2 mainnet vault (live) — created 27 Nov 2026
[`0x5c13500A4aD4277a13C7d774a78Cfd267A202030`](https://hsk.blockscout.com/address/0x5c13500A4aD4277a13C7d774a78Cfd267A202030). The owner wallet `0x5bb8…4208` created it through the Owner Console in tx [`0x50e4f0c4…0100`](https://hsk.blockscout.com/tx/0x50e4f0c427e15efe34ffab430705d186f50b5301354dfebecec97b846d560100).
Agent `0x1709…bEA7`; committee Execution Guardian `0xE278…ac5D` + Risk Officer `0x2697…6E29`, **threshold 2-of-2**.

**Try to break it, mainnet (27 Nov 2026): 15/15 blocked**, each by `eth_call` against this vault:
`InvalidPermit` (stolen agent key) · `NotEnoughSignatures(0, 2)` (no countersignature) · `InvalidPermit` (forged committee) · `NotAgent` (outsider; guardian submitting) · `PolicyMismatch` (old policy) · `PermitExpired` · `PathMismatch` (route swap) · `NotOwner` (withdraw, rewrite mandate, replace committee, take ownership, guardian unpause) · `NotTighter` (loosen cap 10×) · fake stop-loss refused.

**Live on mainnet (27 Nov 2026)**: owner deposited 1 HSK as WHSK ([`0x766228e7…c7b5`](https://hsk.blockscout.com/tx/0x766228e7d2893d3c94b611e255185b2f1a6a16b8181b1c2e0108419f24f1c7b5)); Guardian, Risk Officer and agent started as three processes with three keys.
Owner then deposited **75 HSK as WHSK** (vault: 76 WHSK ≈ 6.04 USDT cost basis at the 30-min TWAP): [`0xd186b87c…f864`](https://hsk.blockscout.com/tx/0xd186b87c6e84e10b88b09662585141c917075c64702da84cb70bcf5195e8f864).

| Agent action | Transaction |
|---|---|
| Keeper records the NAV high-water mark (`checkBreaker`) | [`0x896f6901…879e`](https://hsk.blockscout.com/tx/0x896f69019e99cb4f0fa13a7fe7b846f0ad52adcf1d16a172f13b1902ba43879e) |
| Anchor #0: decisions 0–474 committed as one Merkle root | [`0x9ad3ce93…dea7`](https://hsk.blockscout.com/tx/0x9ad3ce936fadc559d92351ff835e35f74e8696b835ba1b72ead827771f21dea7) |
| **Chat rule, enforced on-chain**: owner typed "stop for the day after losing 0.5 USDT" in Mission Control; the agent applied it with `tighten()` (daily loss stop 1.0 → 0.5 USDT) | [`0x39007191…88b1`](https://hsk.blockscout.com/tx/0x390071919bf2531efa5853266648ad24f847d0902cc0747efb7a3796d1a288b1) |
| **First countersigned trade**: owner asked "Rebalance 50% to USDT"; agent proposed an EXIT, Guardian + Risk Officer both signed; 38 WHSK → 3.018754 USDT (minOut 3.011207) | [`0x6e02064a…4584`](https://hsk.blockscout.com/tx/0x6e02064a32009d8636bd60c002d9c7ee0fe4b4b88235cda6b7b8c8b769d74584) |

`VAULT=0x5c13…2030 pnpm verify decision 474` → decision re-hashes · anchor root on-chain · Merkle proof verifies → **VERIFIED 3/3**.

`pnpm verify trade 0x6e02064a…4584` → mainnet vault · `execute` sent by the agent · both signers on the committee, distinct, threshold 2-of-2 · agent did not sign its own permit · fill ≥ committee minOut → **VERIFIED 14/14**.

## HSK mainnet (chain 177), v1 — deployed 23 Nov 2026 (superseded, kept for the record)
| Contract | Address | Verification |
|---|---|---|
| CountersignVault (implementation) | [`0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF`](https://hsk.blockscout.com/address/0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF) | Sourcify **exact_match** · Blockscout **full match** |
| VaultFactory | [`0x28ae19424647A051b95944DB26ffC0102085fBfE`](https://hsk.blockscout.com/address/0x28ae19424647A051b95944DB26ffC0102085fBfE) | Sourcify **exact_match** · Blockscout **full match** |

| Step | Transaction | Block | Gas |
|---|---|---|---|
| Deploy implementation | [`0x45349cad…1a107a`](https://hsk.blockscout.com/tx/0x45349cad97d944ebcce9b1870a520998ef0d7fec131993721493ad2eee1a107a) | 30,534,351 | 3,863,337 |
| Deploy factory | [`0x97caf3ac…ae1cf2`](https://hsk.blockscout.com/tx/0x97caf3acc7d7ca0575c58bec9fab3b08df38c4492cf347f8b325bbb7b0ae1cf2) | 30,534,353 | 626,376 |

Total cost: 2.2455 HSK at 500 gwei. The addresses match testnet because the deployer nonce was 0 on both chains.

### Owner mainnet vault
[`0x76fB3ae6c48964171a297C88a16513284CfB9eE0`](https://hsk.blockscout.com/address/0x76fB3ae6c48964171a297C88a16513284CfB9eE0), created by the owner wallet `0x5bb8…4208` through the Owner Console.
Mandate: 5 USDT per trade, 20 USDT per day, 1 USDT daily-loss stop, 10 USDT max exposure per asset, 120 s cooldown, 30-min TWAP floor with 1% slippage, 30 bps minimum edge, tiers A+B+C, assets WHSK+WETH+WBTC. Expires around 7 Dec 2026.
