import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex, type LocalAccount } from "viem";
import type { PermitJson } from "./types.js";

/** Must match CountersignVault.PERMIT_TYPEHASH field-for-field. */
export const PERMIT_TYPES = {
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

export const domainFor = (chainId: number, vault: Address) => ({ name: "Countersign", version: "1", chainId, verifyingContract: vault }) as const;

export const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function encodePath(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return encodePacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

/** Deterministic trade id: one per (vault, proposal, leg). Re-submitting the same id is refused on-chain. */
export function tradeIdFor(vault: Address, proposalId: string, leg: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "string" }, { type: "uint256" }], [vault, proposalId, BigInt(leg)]));
}

export function toMessage(p: PermitJson) {
  return {
    tradeId: p.tradeId,
    tier: p.tier,
    pathHash: p.pathHash,
    amountIn: BigInt(p.amountIn),
    minOut: BigInt(p.minOut),
    refAmountOut: BigInt(p.refAmountOut),
    expectedNetValue: BigInt(p.expectedNetValue),
    predictionHash: p.predictionHash,
    decisionHash: p.decisionHash,
    policyHash: p.policyHash,
    deadline: BigInt(p.deadline),
  };
}

export async function signPermit(account: LocalAccount, chainId: number, vault: Address, p: PermitJson): Promise<Hex> {
  return account.signTypedData({ domain: domainFor(chainId, vault), types: PERMIT_TYPES, primaryType: "ExecutionPermit", message: toMessage(p) });
}
