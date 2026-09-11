#!/usr/bin/env bash
# uid-probe scenario (T3-pnpm, uid half): the agent container runs as the host runner's
# uid/gid (never root) with a writable HOME. The script body records `id -u`, `id -g`, and a
# HOME write probe into the committed README; the scenario asserts they equal the runner's
# own uid/gid. (The offline-pnpm half of T3-pnpm is covered by pnpm e2e:docker in ci.yml /
# verify, which builds the fixowl root Dockerfile and runs pnpm with no network.)

UP_ISSUE=""
UP_UID=""
UP_GID=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  UP_UID="$(id -u)"
  UP_GID="$(id -g)"
  local body
  # Single quotes are intentional: $(id -u)/$(id -g)/$HOME must expand INSIDE the container
  # at run time (as the host uid/gid), not here at seed time.
  # shellcheck disable=SC2016
  body="$(printf 'set -e\n{ echo "uid=$(id -u)"; echo "gid=$(id -g)"; (touch "$HOME/.probe" && echo "home-ok") || echo "home-fail"; } >> README.md\n')"
  UP_ISSUE="$(e2e_create_issue "[$RUN_TAG] container uid probe" "$body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$UP_ISSUE" || return 1
  echo "host uid=$UP_UID gid=$UP_GID"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=1"
}

scenario_assert() {
  local run_rc="$1"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_pr_for "$UP_ISSUE" || rc=1
  # Read the committed README on the issue's PR branch and verify the probe output.
  local branch readme
  branch="$(jq -r --arg p "issue/$UP_ISSUE-" '[.[] | select(.headRefName | startswith($p)) | .headRefName][0] // ""' <<<"$E2E_PRS_JSON")"
  if [ -z "$branch" ]; then
    echo "ASSERT FAILED: no branch for issue #$UP_ISSUE to read the probe from" >&2
    return 1
  fi
  readme="$(gh api "repos/$R/contents/README.md?ref=$branch" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)"
  grep -q "uid=$UP_UID" <<<"$readme" \
    || { echo "ASSERT FAILED: container uid != host uid ($UP_UID); probe output:" >&2; grep -E 'uid=|gid=|home-' <<<"$readme" >&2; rc=1; }
  grep -q "gid=$UP_GID" <<<"$readme" \
    || { echo "ASSERT FAILED: container gid != host gid ($UP_GID)" >&2; rc=1; }
  grep -q "home-ok" <<<"$readme" \
    || { echo "ASSERT FAILED: container HOME was not writable" >&2; rc=1; }
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
