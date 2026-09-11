#!/usr/bin/env node
"use strict";

// Harness wrapper for the free/paid E2E jobs. Runs as a JavaScript `uses:` step so the
// runner injects ACTIONS_RUNTIME_TOKEN into this process (and anything it spawns). That is
// the one thing a plain `run:` step cannot get, and it is what makes the bundle's
// @actions/artifact evidence upload land in THIS workflow run. See action.yml.

const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

// GitHub sets action inputs as INPUT_<NAME upper-cased, spaces->_, hyphens kept>.
function input(name) {
  const key = "INPUT_" + name.toUpperCase().replace(/ /g, "_");
  const value = process.env[key];
  return value === undefined ? "" : value.trim();
}

const eventName = input("event-name");
if (eventName !== "") process.env.GITHUB_EVENT_NAME = eventName;

const command = input("command");
if (command !== "") {
  // Suite mode: the child (the scenario runner) inherits ACTIONS_RUNTIME_TOKEN and does its
  // own per-scenario retargeting and `node dist/action/index.js` invocation.
  const result = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(String(result.error));
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

// Direct mode: retarget GITHUB_* at the sandbox, then run the ESM bundle in THIS process so
// its evidence artifacts upload into the current run. The bundle reads GITHUB_REPOSITORY /
// GITHUB_WORKSPACE / core.getInput(...) at runtime, so setting process.env first is enough.
const repository = input("repository");
const workspace = input("workspace");
if (repository !== "") process.env.GITHUB_REPOSITORY = repository;
if (workspace !== "") process.env.GITHUB_WORKSPACE = workspace;

// run.cjs lives at <repo>/.github/actions/e2e-run/run.cjs; the bundle is <repo>/dist/action/index.js.
const bundle = path.resolve(__dirname, "..", "..", "..", "dist", "action", "index.js");
import(pathToFileURL(bundle).href).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
