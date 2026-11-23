import type { GuardianResponse, Proposal } from "../../guardian/types.js";

/** HTTP client for the Guardian process. The agent never holds the Guardian key. */
export class GuardianClient {
  constructor(private readonly baseUrl = process.env.GUARDIAN_URL ?? "http://127.0.0.1:8788") {}

  async evaluate(p: Proposal, dryRun: boolean): Promise<GuardianResponse | { unreachable: string }> {
    try {
      const r = await fetch(`${this.baseUrl}/v1/evaluate${dryRun ? "?dryRun=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return { unreachable: `HTTP ${r.status}: ${await r.text()}` };
      return (await r.json()) as GuardianResponse;
    } catch (e) {
      return { unreachable: (e as Error).message };
    }
  }

  async release(tradeId: string) {
    await fetch(`${this.baseUrl}/v1/release`, { method: "POST", body: JSON.stringify({ tradeId }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
}
