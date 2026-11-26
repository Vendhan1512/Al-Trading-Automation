import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { buildLevels, leafOf, proofOf, rootOf, verifyProof } from "../src/modules/evidence/merkle.js";
import { v2Out } from "../src/modules/arbitrage/radar.js";

const h = (i: number) => keccak256(toHex(`decision-${i}`)) as Hex;

describe("decision Merkle anchoring", () => {
  it("every leaf of every tree size proves against the root", () => {
    for (const n of [1, 2, 3, 5, 8, 13, 100]) {
      const leaves = Array.from({ length: n }, (_, i) => leafOf(1000 + i, h(i)));
      const root = rootOf(leaves);
      for (let i = 0; i < n; i++) expect(verifyProof(leaves[i]!, proofOf(leaves, i), root)).toBe(true);
    }
  });
  it("a tampered decision or a shifted sequence number fails", () => {
    const leaves = Array.from({ length: 9 }, (_, i) => leafOf(i, h(i)));
    const root = rootOf(leaves);
    expect(verifyProof(leafOf(3, h(99)), proofOf(leaves, 3), root)).toBe(false);
    expect(verifyProof(leafOf(4, h(3)), proofOf(leaves, 3), root)).toBe(false);
  });
  it("levels shrink to one root", () => {
    expect(buildLevels([h(1), h(2), h(3)]).at(-1)).toHaveLength(1);
  });
});

describe("arbitrage radar math", () => {
  it("Uniswap-v2 output with 0.30% fee and price impact", () => {
    // 1,000 in against a 1,000,000 / 1,000,000 pool: ~0.3% fee + ~0.1% impact
    const out = v2Out(1_000n * 10n ** 6n, 10n ** 12n, 10n ** 12n);
    expect(Number(out) / 1e6).toBeCloseTo(996.006, 2);
    expect(v2Out(0n, 1n, 1n)).toBe(0n);
  });
  it("a tiny pool makes a large gap unharvestable", () => {
    // $36 pool priced 2% cheaper: buying $5 moves the price ~13% against us
    const out = v2Out(5_000_000n, 36_000_000n, 454n * 10n ** 18n);
    const effective = 5 / (Number(out) / 1e18);
    expect(effective).toBeGreaterThan((36 / 454) * 1.12);
  });
});
