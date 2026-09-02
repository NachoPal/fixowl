import { build } from "esbuild";

const createRequireShim =
  "import { createRequire as __fixowlCreateRequire } from 'node:module';" +
  "const require = __fixowlCreateRequire(import.meta.url);";

await build({
  entryPoints: ["packages/action/src/entry.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/action/index.js",
  banner: { js: createRequireShim },
  logLevel: "info",
});

await build({
  entryPoints: ["packages/cli/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "packages/cli/dist/index.js",
  banner: { js: `#!/usr/bin/env node\n${createRequireShim}` },
  logLevel: "info",
});
