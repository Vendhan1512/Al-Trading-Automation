// "Try to break it" — runs real attacks against the live vault with eth_call (no wallet, no gas)
// and shows the contract's own revert for each. Uses viem in the browser; nothing is signed with
// any real key: attacker keys are generated fresh in this page and thrown away.
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  toHex,
} from "https://esm.sh/viem@2.58.4";
import { generatePrivateKey, privateKeyToAccount } from "https://esm.sh/viem@2.58.4/accounts";
import { vaultAbi } from "./countersign-abi.js";

const TYPES = {
  ExecutionPermit: [
    { name: "tradeId", type: "bytes32" },
    { name: "tier", type: "uint8" },
    { name: "pathHash", type: "bytes32" },
    { name: "amountIn", type: "uint256" },
    { name: "minOut", type: "uint256" },
    { name: "refAmountOut", type: "uint256" },
    { name: "expectedNetValue", type: "int256" },
    { name: "predictionHash", type: "bytes32" },
    { name: "decisionHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
};

async function rawCall(rpc, from, to, data) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data, gas: "0x2dc6c0" }, "latest"] }),
  });
  const j = await r.json();
  if (!j.error) return { reverted: false };
  const raw = typeof j.error.data === "string" ? j.error.data : j.error.data?.data;
  if (raw && raw.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: vaultAbi, data: raw });
      return { reverted: true, name: d.errorName, args: (d.args ?? []).map(String) };
    } catch {
      /* not a vault error */
    }
  }
  return { reverted: true, name: (j.error.message || "reverted").replace(/^execution reverted:?\s*/i, "") || "reverted" };
}

/** Builds the attack list against a v2 vault's live state. */
export async function runAttacks({ rpc, chainId, vault }) {
  const c = createPublicClient({ transport: http(rpc) });
  const read = (functionName, args = []) => c.readContract({ address: vault, abi: vaultAbi, functionName, args });
  const [agent, owner, guardians, threshold, policyHash, assets, quote, mandate] = await Promise.all([
    read("agent"), read("owner"), read("guardians"), read("threshold"), read("policyHash"), read("assets"), read("quote"), read("mandate"),
  ]);
  const asset = assets[0];
  const fee = 3000;
  const path = encodePacked(["address", "uint24", "address"], [quote, fee, asset]);
  const now = Math.floor(Date.now() / 1000);
  const attacker = privateKeyToAccount(generatePrivateKey());
  const attacker2 = privateKeyToAccount(generatePrivateKey());
  const permit = (over = {}) => ({
    tradeId: keccak256(toHex(`break-it-${Math.random()}`)),
    tier: 2,
    pathHash: keccak256(path),
    amountIn: 1_000_000n,
    minOut: 1n,
    refAmountOut: 1n,
    expectedNetValue: 1_000n,
    predictionHash: "0x" + "00".repeat(32),
    decisionHash: keccak256(toHex("attack")),
    policyHash,
    deadline: BigInt(now + 120),
    ...over,
  });
  const sign = (acct, p) => acct.signTypedData({ domain: { name: "Countersign", version: "2", chainId, verifyingContract: vault }, types: TYPES, primaryType: "ExecutionPermit", message: p });
  const sorted = (pairs) => pairs.sort((a, b) => (BigInt(a.by) < BigInt(b.by) ? -1 : 1)).map((x) => x.sig);
  const exec = (p, sigs, pth = path) => encodeFunctionData({ abi: vaultAbi, functionName: "execute", args: [pth, p, sigs] });
  const looser = { ...mandate, maxTradeQuote: mandate.maxTradeQuote * 10n };

  const p1 = permit();
  const p2 = permit();
  const p3 = permit();
  const attacks = [
    { title: "Stolen agent key signs its own permit", who: "agent key", from: agent, data: exec(p1, [await sign(attacker, p1)]), expect: "InvalidPermit" },
    { title: "Stolen agent key, no countersignature at all", who: "agent key", from: agent, data: exec(p2, []), expect: "NotEnoughSignatures" },
    {
      title: `Forge the whole committee (${threshold} fake co-signers)`,
      who: "agent key",
      from: agent,
      data: exec(p3, sorted([{ by: attacker.address, sig: await sign(attacker, p3) }, { by: attacker2.address, sig: await sign(attacker2, p3) }]).slice(0, Math.max(1, Number(threshold)))),
      expect: "InvalidPermit",
    },
    { title: "Outsider submits a trade", who: "stranger", from: attacker.address, data: exec(permit(), []), expect: "NotAgent" },
    { title: "A guardian submits a trade itself", who: "guardian key", from: guardians[0], data: exec(permit(), []), expect: "NotAgent" },
    { title: "Permit signed for an old policy (replay after a rule change)", who: "agent key", from: agent, data: exec(permit({ policyHash: keccak256(toHex("old-policy")) }), []), expect: "PolicyMismatch" },
    { title: "Expired permit", who: "agent key", from: agent, data: exec(permit({ deadline: BigInt(now - 1) }), []), expect: "PermitExpired" },
    { title: "Swap the route after approval", who: "agent key", from: agent, data: exec(permit(), [], encodePacked(["address", "uint24", "address"], [quote, 10000, asset])), expect: "PathMismatch" },
    { title: "Agent withdraws the funds", who: "agent key", from: agent, data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [quote, 1n] }), expect: "NotOwner" },
    { title: "Agent loosens its own trade cap 10×", who: "agent key", from: agent, data: encodeFunctionData({ abi: vaultAbi, functionName: "tighten", args: [looser] }), expect: "NotTighter" },
    { title: "Agent rewrites the mandate", who: "agent key", from: agent, data: encodeFunctionData({ abi: vaultAbi, functionName: "setMandate", args: [looser] }), expect: "NotOwner" },
    { title: "Agent replaces the committee with itself", who: "agent key", from: agent, data: encodeFunctionData({ abi: vaultAbi, functionName: "setCommittee", args: [[attacker.address], 1] }), expect: "NotOwner" },
    { title: "Agent takes ownership of the vault", who: "agent key", from: agent, data: encodeFunctionData({ abi: vaultAbi, functionName: "transferOwnership", args: [agent] }), expect: "NotOwner" },
    { title: "Guardian unpauses / resets the breaker", who: "guardian key", from: guardians[0], data: encodeFunctionData({ abi: vaultAbi, functionName: "resetBreaker" }), expect: "NotOwner" },
    { title: "Fake stop-loss to dump inventory", who: "stranger", from: attacker.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "stopOut", args: [asset, 1n, 0n] }), expect: "NotEnoughTracked|StopNotTriggered" },
  ];
  const results = [];
  for (const a of attacks) {
    const r = await rawCall(rpc, a.from, vault, a.data);
    const blocked = r.reverted && new RegExp(a.expect).test(r.name ?? "");
    results.push({ ...a, ...r, blocked, data: undefined });
  }
  return { vault, owner, agent, guardians, threshold: Number(threshold), results };
}
