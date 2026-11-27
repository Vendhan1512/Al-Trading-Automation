import type { Address } from "viem";

// Attack catalogue and shared types. No viem here, so the page loads it without the chain library.
export const RPCS: Record<number, string> = { 177: "https://mainnet.hsk.xyz", 133: "https://testnet.hsk.xyz" };
export const EXPLORERS: Record<number, string> = { 177: "https://hsk.blockscout.com", 133: "https://testnet-explorer.hskchain.net" };
export const DEMO_TESTNET_VAULT = "0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1";

export type Who = "agent key" | "guardian key" | "stranger";
export interface AttackSpec { id: number; title: string; who: Who; expect: string; blurb: string }
export interface AttackResult extends AttackSpec { reverted: boolean; name?: string; args?: string[]; blocked: boolean }

/** The catalogue, in the order it runs. `blurb` explains the attack to a non-developer. */
export const ATTACKS: AttackSpec[] = [
  { id: 0, title: "Stolen agent key signs its own permit", who: "agent key", expect: "InvalidPermit", blurb: "The AI's key is stolen and the thief signs the approval themselves." },
  { id: 1, title: "No countersignature at all", who: "agent key", expect: "NotEnoughSignatures", blurb: "The thief skips the committee and submits the trade bare." },
  { id: 2, title: "Forge the whole committee", who: "agent key", expect: "InvalidPermit", blurb: "Two made-up keys pretend to be the Guardian and the Risk Officer." },
  { id: 3, title: "Outsider submits a trade", who: "stranger", expect: "NotAgent", blurb: "A random wallet tries to trade with your money." },
  { id: 4, title: "A guardian trades by itself", who: "guardian key", expect: "NotAgent", blurb: "A committee member tries to act as the trader." },
  { id: 5, title: "Replay after a rule change", who: "agent key", expect: "PolicyMismatch", blurb: "An approval signed under the old rules is reused." },
  { id: 6, title: "Expired permit", who: "agent key", expect: "PermitExpired", blurb: "An approval past its deadline is submitted." },
  { id: 7, title: "Swap the route after approval", who: "agent key", expect: "PathMismatch", blurb: "The approved route is switched to a worse pool." },
  { id: 8, title: "Agent withdraws the funds", who: "agent key", expect: "NotOwner", blurb: "The AI tries to send the vault's money out." },
  { id: 9, title: "Agent loosens its own limits 10×", who: "agent key", expect: "NotTighter", blurb: "The AI raises its own trade cap." },
  { id: 10, title: "Agent rewrites the mandate", who: "agent key", expect: "NotOwner", blurb: "The AI replaces the owner's rules." },
  { id: 11, title: "Agent replaces the committee", who: "agent key", expect: "NotOwner", blurb: "The AI makes itself the only approver." },
  { id: 12, title: "Agent takes ownership", who: "agent key", expect: "NotOwner", blurb: "The AI tries to become the vault's owner." },
  { id: 13, title: "Guardian resets the breaker", who: "guardian key", expect: "NotOwner", blurb: "A committee member switches the safety breaker back on." },
  { id: 14, title: "Fake stop-loss to dump inventory", who: "stranger", expect: "NotEnoughTracked|StopNotTriggered", blurb: "A stranger fires the stop-loss when prices haven't fallen." },
];


export interface RunInfo { vault: Address; owner: Address; agent: Address; guardians: readonly Address[]; threshold: number }
