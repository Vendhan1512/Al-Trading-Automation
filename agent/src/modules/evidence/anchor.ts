import type { Address, Hex, PublicClient } from "viem";
import { countersignVaultAbi } from "../../abi/countersignVault.js";
import type { Store } from "../../common/store.js";
import type { ChainOps } from "../transactions/tx-manager.js";
import { leafOf, rootOf } from "./merkle.js";

export interface AnchorPolicy {
  everySec: number; // anchor at least this often when there is anything new
  maxPending: number; // ... or as soon as this many decisions are waiting
}
export const DEFAULT_ANCHOR: AnchorPolicy = { everySec: Number(process.env.ANCHOR_EVERY_SEC ?? 6 * 3600), maxPending: 500 };

/**
 * Commits every not-yet-anchored decision to the vault in ONE transaction (~60k gas).
 * On-chain sequence numbers continue from vault.nextDecisionSeq, so ranges are gap-free.
 */
export async function maybeAnchor(
  client: PublicClient,
  ops: ChainOps,
  store: Store,
  vault: Address,
  policy: AnchorPolicy = DEFAULT_ANCHOR,
  now = Date.now(),
): Promise<{ anchored: false; reason: string } | { anchored: true; idx: number; from: number; to: number; root: Hex; tx: Hex }> {
  const last = store.lastAnchor();
  const pending = store.decisionHashesFrom(last ? last.local_to + 1 : 1);
  if (pending.length === 0) return { anchored: false, reason: "nothing new" };
  const lastAt = last ? (store.db.prepare("SELECT at FROM anchors WHERE idx = ?").get(last.idx) as { at: number }).at : 0;
  if (pending.length < policy.maxPending && now - lastAt < policy.everySec * 1000) return { anchored: false, reason: `${pending.length} pending, next anchor due later` };

  const onchainFrom = Number(await client.readContract({ address: vault, abi: countersignVaultAbi, functionName: "nextDecisionSeq" }));
  const idx = Number(await client.readContract({ address: vault, abi: countersignVaultAbi, functionName: "anchorCount" }));
  const leaves = pending.map((d, i) => leafOf(onchainFrom + i, d.hash as Hex));
  const root = rootOf(leaves);
  const to = onchainFrom + pending.length - 1;
  const tx = await ops.anchorDecisions(vault, root, BigInt(onchainFrom), BigInt(to));
  const rc = await client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`anchor tx reverted: ${tx}`);
  store.recordAnchor({ idx, localFrom: pending[0]!.seq, localTo: pending.at(-1)!.seq, onchainFrom, root, tx });
  return { anchored: true, idx, from: onchainFrom, to, root, tx };
}
