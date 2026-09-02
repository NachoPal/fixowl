import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("scripts/.build", { recursive: true });
await build({
  entryPoints: ["scripts/local-docker-e2e.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "scripts/.build/local-docker-e2e.mjs",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const child = spawn("node", ["scripts/.build/local-docker-e2e.mjs"], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
