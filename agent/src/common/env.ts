import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role-scoped secrets. The agent process may see AGENT_PK but never GUARDIAN_PK, and vice
 * versa — so a compromised strategist process cannot countersign its own trades.
 * Both processes read the same local .env file, but each only loads its own keys and refuses
 * to start if the other role's key is present in its environment.
 */
export type Role = "agent" | "guardian";

const SECRET_OF: Record<Role, string> = { agent: "AGENT_PK", guardian: "GUARDIAN_PK" };
const FORBIDDEN: Record<Role, string[]> = {
  agent: ["GUARDIAN_PK", "TEST_OWNER_PK", "OWNER_PK"],
  guardian: ["AGENT_PK", "DEPLOYER_PK", "TEST_OWNER_PK", "OWNER_PK"],
};
const SHARED = ["AGENT", "GUARDIAN", "OWNER", "VAULT", "VAULT_TESTNET", "GUARDIAN_URL", "HSK_MAINNET_RPC", "HSK_TESTNET_RPC", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "STRATEGIST_MODEL", "AGENT_MODE", "MONITOR_INTERVAL_SEC", "COUNTERSIGN_DB", "PORT", "GUARDIAN_PORT"];

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && m[2] !== undefined && m[2] !== "") out[m[1]!] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadScopedEnv(role: Role, file = process.env.COUNTERSIGN_ENV ?? resolve(process.cwd(), "../.env")) {
  for (const k of FORBIDDEN[role]) {
    if (process.env[k]) throw new Error(`[${role}] refusing to start: ${k} must not be visible to the ${role} process`);
  }
  const fileVars = existsSync(file) ? parseDotenv(readFileSync(file, "utf8")) : {};
  const allowed = new Set([...SHARED, SECRET_OF[role]]);
  for (const [k, v] of Object.entries(fileVars)) {
    if (allowed.has(k) && process.env[k] === undefined) process.env[k] = v;
  }
  const secret = process.env[SECRET_OF[role]];
  return { secret: secret as `0x${string}` | undefined, file };
}
