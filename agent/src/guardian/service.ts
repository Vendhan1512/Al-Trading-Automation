import { BaseError, ContractFunctionRevertedError, keccak256, toBytes, type Address, type LocalAccount, type PublicClient } from "viem";
import { countersignVaultAbi } from "../abi/countersignVault.js";
import { vaultFactoryAbi } from "../abi/vaultFactory.js";
import type { NetworkConfig } from "../config.js";
import { canonicalJson, hashPrediction, type Prediction } from "../modules/predictions/prediction.js";
import { evaluateMarket } from "../modules/data-reliability/engine.js";
import { takeSnapshot } from "../modules/market-data/snapshot.js";
import { quoterV2Abi } from "../modules/market-data/abis.js";
import { paperVaultState, readVaultState, TIER, type VaultState } from "../modules/vault/state.js";
import { encodePath, signPermit, toMessage, tradeIdFor, ZERO32 } from "./permit.js";
import { ProposalZ, type GuardianResponse, type PermitJson, type Proposal } from "./types.js";
import { DEFAULT_GUARDIAN_POLICY, validate, type GuardianPolicy, type QuoteSample, type Reservations } from "./validate.js";

/**
 * Guardian service. Holds the Guardian key. Trusts nothing from the agent except intent:
 * it takes its own market snapshot, reads the vault from chain, re-quotes, re-checks, simulates
 * the exact vault call, and only then signs a single-use, short-lived permit.
 */
export class GuardianService {
  private reservations: { id: string; asset: string; quote: bigint; volume: bigint; exposure: bigint; until: number }[] = [];

  constructor(
    private readonly client: PublicClient,
    private readonly net: NetworkConfig,
    private readonly account: LocalAccount,
    private readonly policy: GuardianPolicy = DEFAULT_GUARDIAN_POLICY,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  private activeReservations(nowSec: number, exceptId?: string): Reservations {
    this.reservations = this.reservations.filter((r) => r.until > nowSec);
    const exposure = new Map<string, bigint>();
    let quote = 0n;
    let volume = 0n;
    for (const r of this.reservations) {
      if (r.id === exceptId) continue;
      quote += r.quote;
      volume += r.volume;
      exposure.set(r.asset, (exposure.get(r.asset) ?? 0n) + r.exposure);
    }
    return { quote, volume, exposure };
  }

  /** Called by the agent after a permit was mined or abandoned. */
  release(tradeId: string) {
    this.reservations = this.reservations.filter((r) => r.id !== tradeId);
  }

  async evaluate(raw: unknown, opts: { dryRun?: boolean } = {}): Promise<GuardianResponse> {
    const evaluatedAt = Date.now();
    const nowSec = Math.floor(evaluatedAt / 1000);
    const base = (p: Partial<GuardianResponse>): GuardianResponse => ({
      decision: "REJECT",
      proposalId: "",
      evaluatedAt,
      guardian: this.address,
      dryRun: !!opts.dryRun,
      reasons: [],
      checks: [],
      economics: null,
      plan: null,
      path: null,
      permit: null,
      signature: null,
      simulation: null,
      decisionHash: null,
      ...p,
    });

    const parsed = ProposalZ.safeParse(raw);
    if (!parsed.success) return base({ reasons: [`malformed proposal: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`] });
    const p: Proposal = parsed.data;
    const pool = this.net.pools.find((x) => x.asset === p.asset)!;

    // 1) Only countersign for vaults where this key IS the registered Guardian.
    let vault: VaultState;
    if (p.vault) {
      const isVault = await this.client.readContract({ address: this.net.vaultFactory, abi: vaultFactoryAbi, functionName: "isVault", args: [p.vault as Address] });
      if (!isVault) return base({ proposalId: p.proposalId, reasons: ["vault not created by the Countersign factory"] });
      vault = await readVaultState(this.client, this.net, p.vault as Address);
      if (vault.guardian?.toLowerCase() !== this.address.toLowerCase())
        return base({ proposalId: p.proposalId, reasons: [`this Guardian (${this.address}) is not the vault's guardian (${vault.guardian})`] });
    } else {
      if (!opts.dryRun) return base({ proposalId: p.proposalId, reasons: ["paper proposals are dry-run only"] });
      vault = paperVaultState(this.net);
    }

    // 2) Prediction binding: the hash must be the hash of the payload sent.
    if (p.prediction || p.predictionHash) {
      const ok = !!p.prediction && !!p.predictionHash && hashPrediction(p.prediction as unknown as Prediction) === p.predictionHash;
      if (!ok) return base({ proposalId: p.proposalId, reasons: ["predictionHash does not match the prediction payload"] });
    }

    // 3) Independent market view.
    const snap = await takeSnapshot(this.client, this.net);
    const market = evaluateMarket(snap, this.net.pools.map((x) => x.asset));
    const health = market.assets.find((a) => a.asset === p.asset)!;
    const hskUsd = market.assets.find((a) => a.asset === "WHSK")?.reference ?? market.assets.find((a) => a.asset === "WHSK")?.dexSpot ?? 0.08;

    // 4) Fresh quotes for 1, 2 and 3 legs (adaptive execution comparison).
    const tokenIn = p.side === "BUY" ? pool.quote.address : pool.base.address;
    const tokenOut = p.side === "BUY" ? pool.base.address : pool.quote.address;
    const amountIn = BigInt(p.amountIn);
    const quote = async (amt: bigint) =>
      (
        await this.client.simulateContract({
          address: this.net.quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn: amt, fee: pool.fee, sqrtPriceLimitX96: 0n }],
        })
      ).result[0];
    const quotes: QuoteSample[] = [];
    for (const legs of [1, 2, 3]) {
      const per = amountIn / BigInt(legs);
      if (per === 0n) continue;
      try {
        quotes.push({ legs, amountInPerLeg: per, amountOutPerLeg: await quote(per) });
      } catch {
        if (legs === 1) return base({ proposalId: p.proposalId, reasons: ["QuoterV2 could not quote this trade"] });
      }
    }

    // 5) The vault's own TWAP floor for this exact trade (paper: same math off-chain).
    const twapFloor = p.vault
      ? await this.client.readContract({ address: p.vault as Address, abi: countersignVaultAbi, functionName: "twapFloor", args: [tokenIn, tokenOut, pool.fee, amountIn] })
      : 0n;

    const gasPriceWei = await this.client.getGasPrice();
    const v = validate({
      proposal: p,
      health,
      chainStatus: market.chain.status,
      vault,
      feePpm: pool.fee,
      baseDecimals: pool.base.decimals,
      quoteDecimals: pool.quote.decimals,
      quotes,
      twapFloor,
      gasPriceWei,
      hskUsd,
      nowSec,
      reservations: this.activeReservations(nowSec),
      policy: this.policy,
    });

    const path = encodePath(tokenIn, pool.fee, tokenOut);
    const record = {
      proposal: p,
      guardian: this.address,
      evaluatedAt,
      decision: v.decision,
      checks: v.checks,
      market: { status: health.status, dexSpot: health.dexSpot, reference: health.reference, premiumBps: health.premiumBps, blockNumber: market.chain.blockNumber },
      plan: v.plan,
    };
    const decisionHash = keccak256(toBytes(canonicalJson(JSON.parse(JSON.stringify(record, (_k, x) => (typeof x === "bigint" ? x.toString() : x))))));
    const resp = base({
      decision: v.decision,
      proposalId: p.proposalId,
      reasons: v.reasons,
      checks: v.checks,
      economics: {
        amountInUsdt: v.economics.amountInUsdt,
        quotedOut: v.economics.quotedOut.toString(),
        minOut: v.minOut.toString(),
        twapFloor: twapFloor.toString(),
        refAmountOut: v.refAmountOut.toString(),
        referencePrice: v.economics.referencePrice,
        dexSpot: v.economics.dexSpot,
        impactBps: v.economics.impactBps,
        edgeBps: v.economics.edgeBps,
        gasUsdt: v.economics.gasUsdt,
        exitCostUsdt: v.economics.exitCostUsdt,
        expectedNetValueUsdt: v.expectedNetValueUsdt,
      },
      plan: v.plan,
      path,
      decisionHash,
    });
    if (v.decision !== "APPROVE" || opts.dryRun || !p.vault) return resp;

    // 6) Sign only the first leg; later legs are re-evaluated when they come due.
    const leg = v.plan.legs[0]!;
    const permit: PermitJson = {
      tradeId: tradeIdFor(p.vault as Address, p.proposalId, leg.index),
      tier: p.tier === "EXIT" ? TIER.EXIT : TIER[p.tier],
      pathHash: keccak256(path),
      amountIn: leg.amountIn,
      minOut: leg.minOut,
      refAmountOut: ((v.refAmountOut * BigInt(leg.amountIn)) / amountIn).toString(),
      expectedNetValue: BigInt(Math.round(v.expectedNetValueUsdt * 10 ** pool.quote.decimals)).toString(),
      predictionHash: (p.predictionHash as `0x${string}` | null) ?? ZERO32,
      decisionHash,
      policyHash: vault.policyHash,
      deadline: nowSec + this.policy.permitTtlSec,
    };
    const signature = await signPermit(this.account, this.net.chainId, p.vault as Address, permit);

    // 7) Simulate the exact call the agent will make. A revert here costs nobody gas.
    try {
      await this.client.simulateContract({
        address: p.vault as Address,
        abi: countersignVaultAbi,
        functionName: "execute",
        args: [path, toMessage(permit), signature],
        account: vault.agent as Address,
      });
    } catch (e) {
      let name = (e as Error).message.split("\n")[0];
      if (e instanceof BaseError) {
        const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
        if (r instanceof ContractFunctionRevertedError) name = r.data?.errorName ?? r.reason ?? name;
      }
      const soft = /Cooldown|BelowTwapFloor|Too little received/.test(name ?? "");
      return { ...resp, decision: soft ? "WAIT" : "REJECT", reasons: [...resp.reasons, `simulation reverted: ${name}`], simulation: { ok: false, error: name } };
    }

    const isBuy = p.side === "BUY";
    this.reservations.push({
      id: permit.tradeId,
      asset: p.asset,
      quote: isBuy ? BigInt(leg.amountIn) : 0n,
      volume: isBuy ? BigInt(leg.amountIn) : 0n,
      exposure: isBuy ? BigInt(leg.amountIn) : 0n,
      until: permit.deadline,
    });
    return { ...resp, permit, signature, simulation: { ok: true } };
  }
}
