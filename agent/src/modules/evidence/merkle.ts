import { encodeAbiParameters, keccak256, type Hex } from "viem";

/**
 * Decision Merkle anchoring. Each journaled decision (APPROVE / WAIT / REJECT / SKIP / EXECUTED …)
 * becomes a leaf = keccak256(abi.encode(onchainSeq, decisionHash)). Pairs are hashed sorted
 * (OpenZeppelin MerkleProof convention), odd nodes are promoted, and the root of each contiguous
 * range is committed with vault.anchorDecisions(root, fromSeq, toSeq). One transaction proves
 * hundreds of decisions — including every refusal — were recorded before anyone knew the outcome.
 */
export function leafOf(seq: number, decisionHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [BigInt(seq), decisionHash]));
}

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(`0x${a.slice(2)}${b.slice(2)}`) : keccak256(`0x${b.slice(2)}${a.slice(2)}`));

export function buildLevels(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("no leaves");
  const levels: Hex[][] = [leaves];
  while (levels.at(-1)!.length > 1) {
    const cur = levels.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
  }
  return levels;
}

export const rootOf = (leaves: Hex[]): Hex => buildLevels(leaves).at(-1)![0]!;

export function proofOf(leaves: Hex[], index: number): Hex[] {
  const levels = buildLevels(leaves);
  const proof: Hex[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]!;
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) proof.push(level[sib]!);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce((acc, sib) => hashPair(acc, sib), leaf).toLowerCase() === root.toLowerCase();
}
