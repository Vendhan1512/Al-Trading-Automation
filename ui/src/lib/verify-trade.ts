// In-browser port of `pnpm verify trade`: re-derives a Countersign trade from raw chain data.
// Trusts nothing but the RPC: decodes the calldata, recovers the committee signers from the
// EIP-712 permit, and reads the vault's committee, threshold and policy at the block before.
import { createPublicClient, decodeFunctionData, http, keccak256, parseEventLogs, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { factoryAbi, vaultAbi } from "./abi";
import { RPCS } from "./attacks";

export type VerifyCheck = { name: string; pass: boolean; detail: string };
export type VerifyInfo = { vault?: Address; block?: bigint; signers?: Address[]; amountIn?: bigint; amountOut?: bigint; tier?: number };

const FACTORIES: Record<number, Address> = {
  177: "0x564ae60993717fF696c6E261F3CD7d4Ee9c56af4",
  133: "0xFe19ba9E01aeE243869DfBEFA7B423B13F645779",
};

const PERMIT_TYPES = {
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
} as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Runs the checks one by one, reporting each as it lands (so the UI can animate them). */
export async function verifyTradeInBrowser(chainId: number, txHash: Hex, onCheck: (c: VerifyCheck) => void): Promise<{ checks: VerifyCheck[]; info: VerifyInfo }> {
  const client = createPublicClient({ transport: http(RPCS[chainId]) });
  const checks: VerifyCheck[] = [];
  const info: VerifyInfo = {};
  const add = (name: string, pass: boolean, detail: string) => {
    const c = { name, pass, detail };
    checks.push(c);
    onCheck(c);
  };

  const [tx, rc] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
  const vault = tx.to as Address;
  info.vault = vault;
  info.block = rc.blockNumber;
  const before = rc.blockNumber - 1n;
  add("transaction succeeded", rc.status === "success", `block ${rc.blockNumber}`);
  const isVault = await client.readContract({ address: FACTORIES[chainId], abi: factoryAbi, functionName: "isVault", args: [vault] }).catch(() => false);
  add("target is a Countersign factory vault", !!isVault, short(vault));

  let call: ReturnType<typeof decodeFunctionData<typeof vaultAbi>>;
  try {
    call = decodeFunctionData({ abi: vaultAbi, data: tx.input });
  } catch {
    add("call is vault.execute", false, "not a Countersign call");
    return { checks, info };
  }
  add("call is vault.execute", call.functionName === "execute", call.functionName);
  if (call.functionName !== "execute") return { checks, info };
  const [path, permit, sigs] = call.args as unknown as [Hex, Record<string, any>, Hex[]]; // eslint-disable-line @typescript-eslint/no-explicit-any
  info.tier = Number(permit.tier);
  info.amountIn = permit.amountIn as bigint;

  const read = (functionName: string) => client.readContract({ address: vault, abi: vaultAbi, functionName: functionName as never, blockNumber: before } as never);
  const [agent, guardians, threshold, policyHash] = (await Promise.all([read("agent"), read("guardians"), read("threshold"), read("policyHash")])) as [Address, Address[], number, Hex];
  add("sender was the vault's agent", tx.from.toLowerCase() === agent.toLowerCase(), short(tx.from));
  add("permit policy = vault policy (block −1)", permit.policyHash === policyHash, short(policyHash));
  add("path hash matches the route", keccak256(path) === permit.pathHash, short(permit.pathHash));

  const signers: Address[] = [];
  for (const s of sigs) {
    signers.push(
      await recoverTypedDataAddress({
        domain: { name: "Countersign", version: "2", chainId, verifyingContract: vault },
        types: PERMIT_TYPES,
        primaryType: "ExecutionPermit",
        message: permit as never,
        signature: s,
      }),
    );
  }
  info.signers = signers;
  const members = new Set(guardians.map((g) => g.toLowerCase()));
  const distinct = new Set(signers.map((s) => s.toLowerCase()));
  add("every signer was on the committee", signers.length > 0 && signers.every((s) => members.has(s.toLowerCase())), signers.map(short).join(", "));
  add("signers are distinct", distinct.size === signers.length, `${distinct.size} distinct`);
  add(`threshold met (${threshold}-of-${guardians.length})`, distinct.size >= Number(threshold), `${distinct.size} signatures`);
  add("the agent did not sign its own permit", !signers.some((s) => s.toLowerCase() === agent.toLowerCase()), "");

  const ev = parseEventLogs({ abi: vaultAbi, eventName: "TradeExecuted", logs: rc.logs })[0] as unknown as { address: Address; args: Record<string, any> } | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  add("TradeExecuted emitted by the vault", !!ev && ev.address.toLowerCase() === vault.toLowerCase(), ev ? `tradeId ${short(ev.args.tradeId)}` : "missing");
  if (ev) {
    info.amountOut = ev.args.amountOut as bigint;
    add("event tradeId = permit tradeId", ev.args.tradeId === permit.tradeId, "");
    add("fill ≥ the committee's minOut", (ev.args.amountOut as bigint) >= (permit.minOut as bigint), `${ev.args.amountOut} ≥ ${permit.minOut}`);
    add("expected value committed on-chain", ev.args.expectedNetValue === permit.expectedNetValue, `${ev.args.expectedNetValue}`);
  }
  return { checks, info };
}
