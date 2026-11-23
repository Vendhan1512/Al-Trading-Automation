# Deployments

## Roles
| Role | Address |
|---|---|
| Owner (user wallet) | `0x5bb83E60a7a05A0e1b077B66412a26306e334208` |
| Agent (AI hot key; also deployed the ownerless implementation and factory) | `0x170912F2F8beb252902e9b07F63851B2e284bEA7` |
| Guardian (countersigner) | `0xE278AC403F93b05cad73f6C3C4D0B9E5667fac5D` |

## HSK testnet (chain 133), deployed 23 Nov 2026
| Contract | Address | Verification |
|---|---|---|
| CountersignVault (implementation) | [`0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF`](https://testnet-explorer.hskchain.net/address/0xd195C15A02EAadDEBc4c2Aac0E87f768894401BF) | Sourcify **exact_match** |
| VaultFactory | [`0x28ae19424647A051b95944DB26ffC0102085fBfE`](https://testnet-explorer.hskchain.net/address/0x28ae19424647A051b95944DB26ffC0102085fBfE) | Sourcify **exact_match** |

Deploy transactions: implementation `0xdf19765959304cda2111098272326a928bbb19560e728f2c00fdd3343a537f1c` (3,863,337 gas) and factory `0xca74a1639ada30d4f1dcef21e41ede03e6d31e597ab4bb05851540378c38852a` (626,376 gas).

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

## HSK mainnet (chain 177)
Pending owner approval. Expected cost at 500 gwei: about 2.25 HSK for the implementation and factory, about 0.28 HSK for `createVault`, and about 0.14 HSK per trade.
