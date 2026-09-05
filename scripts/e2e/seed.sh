#!/usr/bin/env bash
# Seed the E2E sandbox with a fresh, throwaway fixture: two `for: agent` issues
# (A, then B) joined by one native `blocked_by` edge (B is blocked_by A). This is
# what exercises fixowl Layer-1 dependency ordering + stacking (B's PR stacks on
# A's branch).
#
# The issue bodies differ by tier:
#   E2E_MODE=paid  -> natural-language edit instructions for the real claude agent
#   E2E_MODE=free  -> deterministic bash edit scripts for the `script` adapter
# Both just append a traceable line to README.md; assertions are on delivery
# (PRs on the expected branches, dependency order, CI green), never on content.
#
# Every title carries a unique RUN_TAG so a run only ever cleans up its own
# fixtures (see cleanup.sh) and concurrent runs never touch each other's issues.
#
# Env in:  SANDBOX_REPO, RUN_TAG, E2E_MODE (paid|free), GH_TOKEN (sandbox PAT)
# Out:     A=<number> and B=<number> appended to $GITHUB_OUTPUT (and echoed)
set -euo pipefail

: "${SANDBOX_REPO:?set SANDBOX_REPO=owner/repo}"
: "${RUN_TAG:?set RUN_TAG to a per-run unique marker}"
: "${E2E_MODE:?set E2E_MODE=paid|free}"

R="$SANDBOX_REPO"

# Belt-and-suspenders: make sure the selector labels exist before we tag issues
# with them, so a missing label never fails the seed. --force is idempotent.
gh label create "for: agent" -R "$R" --color 5319e7 --force >/dev/null 2>&1 || true
gh label create "effort: high" -R "$R" --color b60205 --force >/dev/null 2>&1 || true

if [ "$E2E_MODE" = "free" ]; then
  # The `script` adapter runs the fenced issue body as bash inside the container
  # (cwd = the checked-out working tree). Keep the edit trivial and traceable.
  BODY_A=$'set -e\nprintf \047\\n<!-- HELLO %s -->\\n\047 "'"$RUN_TAG"$'" >> README.md'
  BODY_B=$'set -e\nprintf \047\\n<!-- WORLD %s -->\\n\047 "'"$RUN_TAG"$'" >> README.md'
else
  # Natural-language instructions for the real agent. Deliberately tiny so a
  # sonnet/medium turn is cheap and near-certain to land a clean diff.
  BODY_A="Append a single new line \`<!-- HELLO $RUN_TAG -->\` to the very end of README.md. Change nothing else."
  BODY_B="Append a single new line \`<!-- WORLD $RUN_TAG -->\` to the very end of README.md. Change nothing else."
fi

# Prerequisite A (plain for: agent).
A=$(gh api "repos/$R/issues" \
  -f title="[$RUN_TAG] add HELLO note to README" \
  -f body="$BODY_A" \
  -f 'labels[]=for: agent' \
  --jq .number)

# Dependent B, additionally tagged effort: high. With label-models empty the
# paid run must still pick sonnet/medium for it - directly proving the override.
B=$(gh api "repos/$R/issues" \
  -f title="[$RUN_TAG] add WORLD note to README" \
  -f body="$BODY_B" \
  -f 'labels[]=for: agent' \
  -f 'labels[]=effort: high' \
  --jq .number)

# Native blocked_by: B is blocked_by A. The endpoint takes the blocker's numeric
# DATABASE id (.id), NOT its issue number - passing the number targets the wrong
# issue silently.
A_ID=$(gh api "repos/$R/issues/$A" --jq .id)
gh api -X POST "repos/$R/issues/$B/dependencies/blocked_by" -F issue_id="$A_ID" >/dev/null

echo "seeded [$RUN_TAG] in $R: A=$A (blocker) B=$B (blocked_by A)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "A=$A"
    echo "B=$B"
  } >> "$GITHUB_OUTPUT"
fi
