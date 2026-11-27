// Copies the published JSON snapshot (written by `pnpm publish-site` into web/data) next to the
// static build, so GitHub Pages serves the same data the live agent API would.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(import.meta.dirname, "../../web/data");
const dst = resolve(import.meta.dirname, "../dist/data");
if (existsSync(src)) {
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-data] ${src} -> ${dst}`);
} else console.log("[copy-data] no web/data snapshot found; the build will only work behind the live agent");
