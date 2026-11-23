import { createWalletClient, http, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { countersignVaultAbi } from "../../abi/countersignVault.js";
import { hskChain } from "../../common/chain.js";
import type { NetworkConfig } from "../../config.js";
import { toMessage } from "../../guardian/permit.js";
import type { PermitJson } from "../../guardian/types.js";

export interface ExecutionResult {
  status: "CONFIRMED" | "REVERTED" | "SKIPPED_DUPLICATE" | "FAILED";
  txHash?: Hex;
  blockNumber?: number;
  gasUsed?: string;
  amountOut?: string;
  realizedPnl?: string;
  error?: string;
}

/**
 * Contract executor: submits a Guardian-countersigned permit from the agent key.
 * Idempotency: refuses to submit a tradeId the vault has already consumed.
 * (Phase 5 adds nonce management, replacement/dropped detection and recovery.)
 */
export class Executor {
  private readonly account;
  private readonly wallet;

  constructor(
    private readonly client: PublicClient,
    private readonly net: NetworkConfig,
    agentPk: Hex,
  ) {
    this.account = privateKeyToAccount(agentPk);
    this.wallet = createWalletClient({ account: this.account, chain: hskChain(net), transport: http(net.rpcUrls[0]) });
  }

  get address(): Address {
    return this.account.address;
  }

  async execute(vault: Address, path: Hex, permit: PermitJson, signature: Hex): Promise<ExecutionResult> {
    const used = await this.client.readContract({ address: vault, abi: countersignVaultAbi, functionName: "usedTradeIds", args: [permit.tradeId] });
    if (used) return { status: "SKIPPED_DUPLICATE", error: "tradeId already executed on-chain" };
    try {
      const { request } = await this.client.simulateContract({
        address: vault,
        abi: countersignVaultAbi,
        functionName: "execute",
        args: [path, toMessage(permit), signature],
        account: this.account,
      });
      const txHash = await this.wallet.writeContract(request);
      const rc = await this.client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (rc.status !== "success") return { status: "REVERTED", txHash, blockNumber: Number(rc.blockNumber), gasUsed: rc.gasUsed.toString() };
      const ev = parseEventLogs({ abi: countersignVaultAbi, eventName: "TradeExecuted", logs: rc.logs })[0];
      const args = ev?.args as { amountOut?: bigint; realizedPnl?: bigint } | undefined;
      return {
        status: "CONFIRMED",
        txHash,
        blockNumber: Number(rc.blockNumber),
        gasUsed: rc.gasUsed.toString(),
        amountOut: args?.amountOut?.toString(),
        realizedPnl: args?.realizedPnl?.toString(),
      };
    } catch (e) {
      return { status: "FAILED", error: (e as Error).message.split("\n")[0] };
    }
  }
}
