import { encodeFunctionData, verifyMessage, type Address, type Hex, type PublicClient } from "viem";
import { countersignVaultAbi } from "../abi/countersignVault.js";
import type { NetworkConfig } from "../config.js";
import { readVaultState } from "../modules/vault/state.js";
import type { ChainOps } from "../modules/transactions/tx-manager.js";
import { isTighter, mandateFromJson, mandateToJson } from "./mandate.js";

/**
 * Owner session: the owner signs a plain-text message in their wallet (no transaction, no gas).
 * The server checks the signer equals vault.owner() on-chain. Sessions last 15 minutes.
 * A session never gives anyone spending power — at most it lets the agent TIGHTEN the mandate.
 */
export const SESSION_TTL_SEC = 15 * 60;

export function sessionMessage(vault: string, chainId: number, issuedAtIso: string): string {
  return `Countersign owner session\nVault: ${vault}\nChain: ${chainId}\nIssued: ${issuedAtIso}\nThis signature does not move funds or approve any transaction.`;
}

export interface OwnerAuth {
  address: Address;
  issuedAt: string; // ISO
  signature: Hex;
}

export async function verifyOwner(client: PublicClient, net: NetworkConfig, vault: Address, auth: OwnerAuth | undefined, nowMs = Date.now()) {
  if (!auth) return { ok: false as const, reason: "owner session required — connect the owner wallet and sign in" };
  const issued = Date.parse(auth.issuedAt);
  if (!Number.isFinite(issued) || nowMs - issued > SESSION_TTL_SEC * 1000 || issued - nowMs > 60_000)
    return { ok: false as const, reason: "owner session expired — sign in again" };
  const valid = await verifyMessage({ address: auth.address, message: sessionMessage(vault, net.chainId, auth.issuedAt), signature: auth.signature }).catch(() => false);
  if (!valid) return { ok: false as const, reason: "invalid owner signature" };
  const owner = await client.readContract({ address: vault, abi: countersignVaultAbi, functionName: "owner" });
  if ((owner as string).toLowerCase() !== auth.address.toLowerCase()) return { ok: false as const, reason: "signer is not the vault owner" };
  return { ok: true as const };
}

export type ApplyResult =
  | { status: "APPLIED"; via: "tighten"; txHash: Hex }
  | { status: "OWNER_SIGNATURE_REQUIRED"; via: "setMandate"; tx: { to: Address; data: Hex; chainId: number } }
  | { status: "REFUSED"; reason: string };

/** Apply a proposed mandate: tighter → agent tightens on-chain; looser → unsigned owner tx for the wallet. */
export async function applyMandate(
  client: PublicClient,
  net: NetworkConfig,
  vault: Address,
  proposedJson: Record<string, string | number>,
  auth: OwnerAuth | undefined,
  ops: ChainOps | null,
): Promise<ApplyResult> {
  const who = await verifyOwner(client, net, vault, auth);
  if (!who.ok) return { status: "REFUSED", reason: who.reason };
  let proposed;
  try {
    proposed = mandateFromJson(proposedJson);
  } catch {
    return { status: "REFUSED", reason: "malformed mandate" };
  }
  const v = await readVaultState(client, net, vault);
  if (JSON.stringify(mandateToJson(proposed)) === JSON.stringify(mandateToJson(v.mandate))) return { status: "REFUSED", reason: "no change" };
  if (isTighter(v.mandate, proposed)) {
    if (!ops) return { status: "REFUSED", reason: "agent is not running in live mode; apply as owner instead" };
    const txHash = await ops.tighten(vault, proposed);
    return { status: "APPLIED", via: "tighten", txHash };
  }
  const data = encodeFunctionData({ abi: countersignVaultAbi, functionName: "setMandate", args: [proposed as never] });
  return { status: "OWNER_SIGNATURE_REQUIRED", via: "setMandate", tx: { to: vault, data, chainId: net.chainId } };
}
