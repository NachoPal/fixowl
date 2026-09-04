import { readFileSync } from "node:fs";

// Read the version from the CLI's own package.json at runtime so it can never
// drift from the published version. Both the bundled `dist/index.js` and this
// source module live exactly one level under the package root, so
// `../package.json` resolves to the CLI's package.json in dev, in the esbuild
// bundle, and in the published tarball (`files: ["dist"]` ships `dist/` plus
// `package.json` at the root).
export const version = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
