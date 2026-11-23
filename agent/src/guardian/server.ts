import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET } from "../config.js";
import { makeClient } from "../common/chain.js";
import { loadScopedEnv } from "../common/env.js";
import { GuardianService } from "./service.js";

/**
 * Guardian process (`pnpm guardian`). Separate OS process, separate key, localhost only.
 *   POST /v1/evaluate            -> APPROVE (+ signed permit) | REJECT | WAIT, with every check
 *   POST /v1/evaluate?dryRun=1   -> same evaluation, never signs (copilot "what-if")
 *   POST /v1/release             -> {tradeId} frees a reservation after mining/abandonment
 *   GET  /v1/health
 */
const { secret } = loadScopedEnv("guardian");
if (!secret) throw new Error("GUARDIAN_PK not set (add it to the project .env)");
const account = privateKeyToAccount(secret);
const service = new GuardianService(makeClient(MAINNET), MAINNET, account);
const PORT = Number(process.env.GUARDIAN_PORT ?? 8788);

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isFinite(v) ? null : v)));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, guardian: account.address, chainId: MAINNET.chainId });
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) return json(res, 413, { error: "proposal too large" });
    }
    const data = body ? JSON.parse(body) : {};
    if (url.pathname === "/v1/evaluate") {
      const r = await service.evaluate(data, { dryRun: url.searchParams.get("dryRun") === "1" });
      console.log(`[guardian] ${r.proposalId} ${r.decision}${r.reasons.length ? " — " + r.reasons.join("; ") : ""}`);
      return json(res, 200, r);
    }
    if (url.pathname === "/v1/release") {
      service.release(String(data.tradeId ?? ""));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message.split("\n")[0] });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[guardian] ${account.address} listening on http://127.0.0.1:${PORT}`));
