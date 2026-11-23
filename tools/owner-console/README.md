# Owner Console

A single-page tool for the **vault owner**. You can create your vault, deposit USDT, pause, unpause, revoke the agent or withdraw, and every action is signed in **your own browser wallet** (MetaMask, Rabby, or a Ledger connected through them). No private key is ever pasted anywhere.

## Run
From the repository root:
```bash
python -m http.server 8080
```
Then open **http://localhost:8080/tools/owner-console/** in the browser that has your wallet.

The page reads the factory address from `contracts/deployments/<chainId>.json`, so serve it from the repo root.

## Steps
1. Pick the network (testnet 133 or mainnet 177) and click **Connect wallet**. The page adds or switches the HSK network in your wallet.
2. Check the mandate. The defaults are small, and the Agent and Guardian addresses are pre-filled. Then click **Create my vault** and approve in your wallet.
3. Deposit USDT into the vault. Use **Pause**, **Revoke agent** or **Withdraw** at any time.
