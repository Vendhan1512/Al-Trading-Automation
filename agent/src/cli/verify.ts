import { decodeFunctionData, keccak256, parseEventLogs, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";
import { countersignVaultAbi } from "../abi/countersignVault.js";
import { vaultFactoryAbi } from "../abi/vaultFactory.js";
import { MAINNET, type NetworkConfig } from "../config.js";
import { makeClient } from "../common/chain.js";
import { Store } from "../common/store.js";
import { canonicalJson } from "../modules/predictions/prediction.js";
import { leafOf, proofOf, verifyProof } from "../modules/evidence/merkle.js";
import { domainFor, PERMIT_TYPES } from "../guardian/permit.js";

/**
 * Independent verifier — trusts nothing but the chain (and, for decisions, the local journal).
 *   pnpm verify trade <txHash> [--testnet]
 *   pnpm verify decision <seq>
 */
type Check = { name: string; pass: boolean; detail: string };
const line = (c: Check) => `${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} ${c.detail}`;

export async function verifyTrade(net: NetworkConfig, txHash: Hex): Promise<Check[]> {
  const client = makeClient(net);
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const [tx, rc] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
  const vault = tx.to as Address;
  const before = rc.blockNumber - 1n;
  add("transaction succeeded", rc.status === "success", `block ${rc.blockNumber}`);
  const isVault = await client.readContract({ address: net.vaultFactory, abi: vaultFactoryAbi, functionName: "isVault", args: [vault] }).catch(() => false);
  add("target is a Countersign factory vault", !!isVault, vault);

  const call = decodeFunctionData({ abi: countersignVaultAbi, data: tx.input });
  add("call is vault.execute", call.functionName === "execute", call.functionName);
  if (call.functionName !== "execute") return checks;
  const [path, permit, sigs] = call.args as unknown as [Hex, Record<string, unknown>, Hex[]];

  const at = { blockNumber: before } as const;
  const r = (functionName: string) => client.readContract({ address: vault, abi: countersignVaultAbi, functionName: functionName as never, ...at } as never);
  const [agent, guardians, threshold, policyHash] = (await Promise.all([r("agent"), r("guardians"), r("threshold"), r("policyHash")])) as [Address, Address[], number, Hex];
  add("sender was the vault's agent", tx.from.toLowerCase() === agent.toLowerCase(), `${tx.from}`);
  add("permit policy = vault policy (block-1)", permit.policyHash === policyHash, String(policyHash));
  add("path hash matches the route", keccak256(path) === permit.pathHash, String(permit.pathHash));

  const signers: Address[] = [];
  for (const s of sigs) {
    signers.push(await recoverTypedDataAddress({ domain: domainFor(net.chainId, vault), types: PERMIT_TYPES, primaryType: "ExecutionPermit", message: permit as never, signature: s }));
  }
  const members = new Set(guardians.map((g) => g.toLowerCase()));
  const distinct = new Set(signers.map((s) => s.toLowerCase()));
  add("every signer was on the committee", signers.every((s) => members.has(s.toLowerCase())), signers.join(", "));
  add("signers are distinct", distinct.size === signers.length, `${distinct.size} distinct`);
  add(`threshold met (${threshold}-of-${guardians.length})`, distinct.size >= Number(threshold), `${distinct.size} signatures`);
  add("the agent did not sign its own permit", !signers.some((s) => s.toLowerCase() === agent.toLowerCase()), "");

  const ev = parseEventLogs({ abi: countersignVaultAbi, eventName: "TradeExecuted", logs: rc.logs })[0];
  add("TradeExecuted emitted by the vault", !!ev && ev.address.toLowerCase() === vault.toLowerCase(), ev ? `tradeId ${ev.args.tradeId}` : "missing");
  if (ev) {
    add("event tradeId = permit tradeId", ev.args.tradeId === permit.tradeId, "");
    add("fill >= the committee's minOut", ev.args.amountOut >= (permit.minOut as bigint), `${ev.args.amountOut} >= ${permit.minOut}`);
    add("expected value committed on-chain", ev.args.expectedNetValue === permit.expectedNetValue, `${ev.args.expectedNetValue}`);
    const store = new Store();
    const pred = store.predictions().find((p) => p.hash === ev.args.predictionHash);
    if (ev.args.predictionHash !== "0x" + "00".repeat(32)) {
      add("prediction payload re-hashes to the committed hash", !!pred && keccak256(toBytes(canonicalJson(JSON.parse(pred.payload)))) === ev.args.predictionHash, pred ? "local journal" : "payload not in local journal");
    }
  }
  return checks;
}

export async function verifyDecision(net: NetworkConfig, vault: Address, seq: number): Promise<Check[]> {
  const store = new Store();
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const d = store.decisionRow(seq);
  if (!d) return [{ name: "decision exists", pass: false, detail: `#${seq}` }];
  const recomputed = keccak256(toBytes(canonicalJson({ now: d.at, kind: d.kind, summary: d.summary, payload: JSON.parse(d.payload) })));
  add("decision record re-hashes", recomputed === d.hash, d.hash);
  const a = store.anchorFor(seq);
  if (!a) return [...checks, { name: "decision is anchored", pass: false, detail: "not yet anchored (anchors run every few hours)" }];
  const range = store.decisionHashesFrom(a.local_from).filter((x) => x.seq <= a.local_to);
  const leaves = range.map((x, i) => leafOf(a.onchain_from + i, x.hash as Hex));
  const i = range.findIndex((x) => x.seq === seq);
  const onchainRoot = (await makeClient(net).readContract({ address: vault, abi: countersignVaultAbi, functionName: "anchors", args: [BigInt(a.idx)] })) as Hex;
  add("anchor root is on-chain", onchainRoot.toLowerCase() === a.root.toLowerCase(), `anchor #${a.idx} tx ${a.tx}`);
  add("Merkle proof verifies against the on-chain root", verifyProof(leaves[i]!, proofOf(leaves, i), onchainRoot), `leaf ${i} of ${leaves.length}, on-chain seq ${a.onchain_from + i}`);
  return checks;
}

// CLI
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/verify.ts")) {
  const [kind, arg] = process.argv.slice(2);
  const net: NetworkConfig = process.argv.includes("--testnet")
    ? { ...MAINNET, chainId: 133, rpcUrls: ["https://testnet.hsk.xyz"], vaultFactory: (process.env.TESTNET_FACTORY ?? "0xFe19ba9E01aeE243869DfBEFA7B423B13F645779") as Address }
    : MAINNET;
  const run = kind === "trade" ? verifyTrade(net, arg as Hex) : verifyDecision(net, process.env.VAULT as Address, Number(arg));
  const checks = await run;
  for (const c of checks) console.log(line(c));
  const ok = checks.every((c) => c.pass);
  console.log(ok ? `\nVERIFIED — ${checks.length}/${checks.length} checks passed` : `\nNOT VERIFIED — ${checks.filter((c) => !c.pass).length} check(s) failed`);
  process.exit(ok ? 0 : 1);
}
