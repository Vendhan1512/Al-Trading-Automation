import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET } from "../config.js";
import { makeClient } from "../common/chain.js";
import { loadScopedEnv } from "../common/env.js";
import { RiskOfficerService } from "./risk-officer.js";

/**
 * Risk Officer process (`pnpm risk`). Separate OS process, separate key, localhost only.
 *   POST /v1/cosign            {proposal, permit, path, guardianSignature} -> APPROVE (+signature) | VETO | WAIT
 *   POST /v1/cosign?dryRun=1   evaluation only, never signs
 *   GET  /v1/health
 */
const { secret } = loadScopedEnv("risk");
if (!secret) throw new Error("RISK_OFFICER_PK not set (add it to the project .env)");
const account = privateKeyToAccount(secret);
const service = new RiskOfficerService(makeClient(MAINNET), MAINNET, account);
const PORT = Number(process.env.RISK_PORT ?? 8789);

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isFinite(v) ? null : v)));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, riskOfficer: account.address, chainId: MAINNET.chainId });
    if (req.method !== "POST" || url.pathname !== "/v1/cosign") return json(res, 404, { error: "not found" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) return json(res, 413, { error: "too large" });
    }
    const r = await service.cosign(body ? JSON.parse(body) : {}, { dryRun: url.searchParams.get("dryRun") === "1" });
    console.log(`[risk-officer] ${r.decision}${r.reasons.length ? " — " + r.reasons.join("; ") : ""}`);
    return json(res, 200, r);
  } catch (e) {
    return json(res, 500, { error: (e as Error).message.split("\n")[0] });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[risk-officer] ${account.address} listening on http://127.0.0.1:${PORT}`));
