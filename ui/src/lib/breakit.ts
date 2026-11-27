// "Try to break it": real attacks against a live v2 vault, run with eth_call from the browser
// (no wallet, no gas). Attacker keys are generated here and thrown away; nothing real is signed.
import { createPublicClient, decodeErrorResult, encodeFunctionData, encodePacked, http, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { vaultAbi } from "./abi";
import { ATTACKS, type AttackResult, type RunInfo } from "./attacks";
export type { AttackResult, RunInfo } from "./attacks";

const TYPES = {
  ExecutionPermit: [
    { name: "tradeId", type: "bytes32" }, { name: "tier", type: "uint8" }, { name: "pathHash", type: "bytes32" },
    { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "refAmountOut", type: "uint256" },
    { name: "expectedNetValue", type: "int256" }, { name: "predictionHash", type: "bytes32" }, { name: "decisionHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" }, { name: "deadline", type: "uint64" },
  ],
} as const;

async function rawCall(rpc: string, from: Address, to: Address, data: Hex) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data, gas: "0x2dc6c0" }, "latest"] }),
  });
  const j = (await r.json()) as { error?: { message?: string; data?: string | { data?: string } } };
  if (!j.error) return { reverted: false };
  const raw = typeof j.error.data === "string" ? j.error.data : j.error.data?.data;
  if (raw && raw.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: vaultAbi, data: raw as Hex });
      return { reverted: true, name: d.errorName, args: ((d.args ?? []) as unknown[]).map(String) };
    } catch {
      /* not a vault error */
    }
  }
  return { reverted: true, name: (j.error.message || "reverted").replace(/^execution reverted:?\s*/i, "") || "reverted" };
}

type Permit = {
  tradeId: Hex; tier: number; pathHash: Hex; amountIn: bigint; minOut: bigint; refAmountOut: bigint; expectedNetValue: bigint;
  predictionHash: Hex; decisionHash: Hex; policyHash: Hex; deadline: bigint;
};


/** Runs every attack in order, reporting each result as soon as the chain answers. */
export async function runAttacks(
  { rpc, chainId, vault }: { rpc: string; chainId: number; vault: Address },
  onInfo: (i: RunInfo) => void,
  onResult: (r: AttackResult) => void,
) {
  const c = createPublicClient({ transport: http(rpc) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const read = (functionName: string, args: unknown[] = []) => c.readContract({ address: vault, abi: vaultAbi, functionName, args } as any) as Promise<any>;
  const [agent, owner, guardians, threshold, policyHash, assets, quote, mandate] = await Promise.all([
    read("agent"), read("owner"), read("guardians"), read("threshold"), read("policyHash"), read("assets"), read("quote"), read("mandate"),
  ]);
  onInfo({ vault, owner, agent, guardians, threshold: Number(threshold) });
  const asset = assets[0] as Address;
  const path = encodePacked(["address", "uint24", "address"], [quote, 3000, asset]);
  const now = Math.floor(Date.now() / 1000);
  const attacker = privateKeyToAccount(generatePrivateKey());
  const attacker2 = privateKeyToAccount(generatePrivateKey());
  const permit = (over: Partial<Permit> = {}): Permit => ({
    tradeId: keccak256(toHex(`break-it-${Math.random()}`)), tier: 2, pathHash: keccak256(path),
    amountIn: 1_000_000n, minOut: 1n, refAmountOut: 1n, expectedNetValue: 1_000n,
    predictionHash: `0x${"00".repeat(32)}`, decisionHash: keccak256(toHex("attack")), policyHash, deadline: BigInt(now + 120), ...over,
  });
  const sign = (acct: PrivateKeyAccount, p: Permit) =>
    acct.signTypedData({ domain: { name: "Countersign", version: "2", chainId, verifyingContract: vault }, types: TYPES, primaryType: "ExecutionPermit", message: p });
  const sorted = (pairs: { by: Address; sig: Hex }[]) => pairs.sort((a, b) => (BigInt(a.by) < BigInt(b.by) ? -1 : 1)).map((x) => x.sig);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enc = (functionName: string, args: unknown[] = []) => encodeFunctionData({ abi: vaultAbi, functionName, args } as any);
  const exec = (p: Permit, sigs: Hex[], pth: Hex = path) => enc("execute", [pth, p, sigs]);
  const looser = { ...mandate, maxTradeQuote: (mandate.maxTradeQuote as bigint) * 10n };

  const p1 = permit(), p2 = permit(), p3 = permit();
  const calls: [Address, Hex][] = [
    [agent, exec(p1, [await sign(attacker, p1)])],
    [agent, exec(p2, [])],
    [agent, exec(p3, sorted([{ by: attacker.address, sig: await sign(attacker, p3) }, { by: attacker2.address, sig: await sign(attacker2, p3) }]).slice(0, Math.max(1, Number(threshold))))],
    [attacker.address, exec(permit(), [])],
    [guardians[0], exec(permit(), [])],
    [agent, exec(permit({ policyHash: keccak256(toHex("old-policy")) }), [])],
    [agent, exec(permit({ deadline: BigInt(now - 1) }), [])],
    [agent, exec(permit(), [], encodePacked(["address", "uint24", "address"], [quote, 10000, asset]))],
    [agent, enc("withdraw", [quote, 1n])],
    [agent, enc("tighten", [looser])],
    [agent, enc("setMandate", [looser])],
    [agent, enc("setCommittee", [[attacker.address], 1])],
    [agent, enc("transferOwnership", [agent])],
    [guardians[0], enc("resetBreaker")],
    [attacker.address, enc("stopOut", [asset, 1n, 0n])],
  ];
  for (const spec of ATTACKS) {
    const [from, data] = calls[spec.id];
    const r = await rawCall(rpc, from, vault, data);
    onResult({ ...spec, ...r, blocked: r.reverted && new RegExp(spec.expect).test(r.name ?? "") });
  }
}
