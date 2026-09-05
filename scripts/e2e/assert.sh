#!/usr/bin/env bash
# Loose end-to-end assertions against the sandbox after a fixowl night. The agent
# (or bash script) diff is not asserted - only DELIVERY is:
#   1. a PR exists whose head branch is issue/<A>-*        (A shipped)
#   2. a PR exists whose head branch is issue/<B>-*        (B shipped)
#   3. B's PR base == A's branch                           (Layer-1 dep stacking)
#   4. both PRs are out of draft (isDraft==false)          (CI gate went green)
#
# "not draft" is a clean proxy for "CI green": the pipeline opens a draft PR,
# polls the head SHA's required checks, and only flips it ready on green; a
# red/timeout/exhausted run leaves the PR a draft.
#
# Env in: SANDBOX_REPO, A, B, GH_TOKEN (sandbox PAT)
set -euo pipefail

: "${SANDBOX_REPO:?set SANDBOX_REPO=owner/repo}"
: "${A:?set A to the prerequisite issue number}"
: "${B:?set B to the dependent issue number}"

R="$SANDBOX_REPO"

gh pr list -R "$R" --state all --limit 100 \
  --json number,headRefName,baseRefName,isDraft > prs.json
echo "PRs in $R:"
jq -r '.[] | "  #\(.number) head=\(.headRefName) base=\(.baseRefName) draft=\(.isDraft)"' prs.json

fail() { echo "ASSERT FAILED: $1" >&2; exit 1; }

# 1) a PR for A
jq -e --arg a "issue/$A-" \
  'any(.[]; .headRefName | startswith($a))' prs.json >/dev/null \
  || fail "no PR on an issue/$A-* branch (prerequisite A did not ship)"

# 2) a PR for B
jq -e --arg b "issue/$B-" \
  'any(.[]; .headRefName | startswith($b))' prs.json >/dev/null \
  || fail "no PR on an issue/$B-* branch (dependent B did not ship)"

# 3) dependency order respected: B's PR base is A's branch (Layer-1 stacking)
jq -e --arg a "issue/$A-" --arg b "issue/$B-" \
  'any(.[]; (.headRefName | startswith($b)) and (.baseRefName | startswith($a)))' prs.json >/dev/null \
  || fail "B's PR does not stack on A's branch (dependency order not respected)"

# 4) CI green -> both PRs flipped out of draft
jq -e --arg a "issue/$A-" \
  'any(.[]; (.headRefName | startswith($a)) and (.isDraft == false))' prs.json >/dev/null \
  || fail "A's PR is still a draft (CI never went green)"
jq -e --arg b "issue/$B-" \
  'any(.[]; (.headRefName | startswith($b)) and (.isDraft == false))' prs.json >/dev/null \
  || fail "B's PR is still a draft (CI never went green)"

echo "ALL ASSERTIONS PASSED: A and B shipped, B stacked on A, both PRs CI-green."
