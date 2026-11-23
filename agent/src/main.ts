import type { Address } from "viem";
import { MAINNET } from "./config.js";
import { makeClient } from "./common/chain.js";
import { loadScopedEnv } from "./common/env.js";
import { Store } from "./common/store.js";
import { startApi } from "./api/server.js";
import { startMarketMonitor } from "./workers/market-monitor.js";
import { runPipeline, type AgentMode } from "./workers/pipeline.js";
import { GuardianClient } from "./modules/execution/guardian-client.js";
import { Executor } from "./modules/execution/executor.js";

/**
 * Agent keeper (`pnpm agent`): market monitor -> reliability -> strategy pipeline -> Guardian ->
 * (live mode) execution, plus the read-only API. Holds ONLY the agent key.
 *   AGENT_MODE=shadow (default) — full decision loop, Guardian dry-run, never sends a transaction
 *   AGENT_MODE=live             — Guardian signs, agent submits (requires VAULT)
 */
const { secret } = loadScopedEnv("agent");
const mode = (process.env.AGENT_MODE ?? "shadow") as AgentMode;
const vault = (process.env.VAULT as Address | undefined) ?? null;
if (mode === "live" && (!vault || !secret)) throw new Error("live mode needs VAULT and AGENT_PK");

const client = makeClient(MAINNET);
const store = new Store();
const ctx = {
  net: MAINNET,
  client,
  store,
  guardian: new GuardianClient(),
  executor: mode === "live" && secret ? new Executor(client, MAINNET, secret) : null,
  vault,
  mode,
  agentId: "countersign-agent-1",
  inFlight: new Set<string>(),
  log: console.log,
};

let busy = false;
startApi(store);
startMarketMonitor(store, MAINNET, {
  verbose: false,
  onTick: (_snap, health, id) => {
    if (busy) return; // never overlap decision cycles
    busy = true;
    runPipeline(ctx, health)
      .then((t) => {
        console.log(
          `#${id} [${mode}/${t.vaultMode}] market ${health.status} · candidates ${t.candidates} → passed ${t.passed} → taken ${t.taken} → approved ${t.approved} → executed ${t.executed} · strategist ${t.strategist}`,
        );
        for (const l of t.lines) console.log(`   ${l}`);
      })
      .catch((e) => console.error(`[pipeline] ${(e as Error).message}`))
      .finally(() => (busy = false));
  },
});
console.log(`[agent] mode=${mode} vault=${vault ?? "paper"} agent-key=${secret ? "loaded" : "none"} guardian=${process.env.GUARDIAN_URL ?? "http://127.0.0.1:8788"}`);
