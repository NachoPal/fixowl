#!/usr/bin/env bash
# CLI smokes of the built `fixowl` binary, run in `verify` (no network writes, no secrets).
# Covers the runtime_token migration rejection, `init --non-interactive`, and "aider is gone".
# Requires `pnpm build` to have produced packages/cli/dist/index.js.
set -euo pipefail

FIXOWL_DIR="$PWD"
CLI="$FIXOWL_DIR/packages/cli/dist/index.js"
[ -f "$CLI" ] || { echo "built CLI not found: $CLI (run pnpm build)" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

fail() { echo "CLI SMOKE FAILED: $1" >&2; exit 1; }

# 1) A config still carrying the removed `runtime_token` is rejected with the migration message.
echo "--- smoke: runtime_token migration rejection ---"
cat > "$TMP/bad.yaml" <<'YAML'
version: 1
github:
  runtime_token: "ghp_oldpat"
  app:
    app_id: 123456
    installation_id: 7890123
    private_key: "dummy"
repos:
  - name: NachoPal/fixowl-e2e-sandbox
YAML
if node "$CLI" validate -c "$TMP/bad.yaml" >"$TMP/rt.out" 2>&1; then
  fail "a config with runtime_token was accepted (should be rejected)"
fi
grep -q "runtime_token (the runtime PAT) was removed" "$TMP/rt.out" \
  || { cat "$TMP/rt.out" >&2; fail "the runtime_token migration message was not shown"; }
echo "runtime_token config rejected with the migration message."

# 2) `init --non-interactive` scaffolds without prompting.
echo "--- smoke: init --non-interactive ---"
node "$CLI" init --non-interactive -c "$TMP/fresh/config.yaml"
echo "init --non-interactive exited cleanly."

# 3) aider is gone from the shipped surfaces.
echo "--- smoke: no aider references ---"
if grep -rn aider packages templates docs README.md; then
  fail "aider references still present"
fi
echo "no aider references."

echo "ALL CLI SMOKES PASSED"
