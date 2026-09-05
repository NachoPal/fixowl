export interface CheckOutcome {
  name: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
  /** Captured command output (bounded); fed back to the agent on a failed pre-check, not rendered in the PR body. */
  log?: string;
}

/** One required CI check that came back red, for the PR body / exhaustion comment. */
export interface CiCheckFailure {
  name: string;
  /** Best-effort human summary (untrusted CI output; sanitized before rendering). */
  summary?: string;
  /** Link to the check's run/logs. */
  detailsUrl?: string;
}

/**
 * How the CI-gated loop ended for a PR: its required checks went green, or the
 * try budget was exhausted with them still red / not completing in time.
 */
export type CiGateSummary =
  | { state: "green"; usedFallback?: boolean }
  | {
      state: "failed";
      reason: "red" | "timeout";
      failures: CiCheckFailure[];
      usedFallback?: boolean;
    };

/**
 * CI check names and summaries are untrusted (a job can echo attacker-controlled
 * text); collapse whitespace and escape table-breaking pipes before rendering.
 */
function ciCell(text: string): string {
  return text.replaceAll(/\s+/g, " ").replaceAll("|", "\\|").trim();
}

/**
 * A check's detailsUrl is semi-untrusted CI output (check-run details_url /
 * legacy commit-status target_url). Render it as a `[logs](...)` target only
 * when it is a well-formed http(s) URL, percent-escaping the characters that
 * would break out of the markdown link (spaces via encodeURI, then parens);
 * anything else (non-http scheme, unparseable) is dropped rather than rendered.
 */
function ciLink(detailsUrl: string | undefined): string {
  if (detailsUrl === undefined || detailsUrl === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(detailsUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const safe = encodeURI(detailsUrl).replaceAll("(", "%28").replaceAll(")", "%29");
  return `[logs](${safe})`;
}

const CI_SUMMARY_MAX = 300;

function renderCiSection(ci: CiGateSummary): string[] {
  const lines: string[] = [`## CI`, ``];
  if (ci.state === "green") {
    lines.push(
      ci.usedFallback === true
        ? `✅ All completed checks passed. (No required checks were readable for the base branch, so fixowl gated on all completed checks.)`
        : `✅ The base branch's required checks are green.`,
    );
    lines.push(``);
    return lines;
  }
  const gate = ci.usedFallback === true ? "checks" : "required checks";
  lines.push(
    ci.reason === "timeout"
      ? `❌ The ${gate} did not complete within fixowl's time budget after the last attempt. This PR is a draft.`
      : `❌ The ${gate} were still red after fixowl's last attempt. This PR is a draft.`,
    ``,
  );
  if (ci.failures.length > 0) {
    lines.push(`| check | detail |`, `| --- | --- |`);
    for (const failure of ci.failures) {
      const summary = failure.summary ? ciCell(failure.summary).slice(0, CI_SUMMARY_MAX) : "";
      const link = ciLink(failure.detailsUrl);
      const detail = [summary, link].filter((part) => part !== "").join(" - ") || "-";
      lines.push(`| ${ciCell(failure.name)} | ${detail} |`);
    }
    lines.push(``);
  }
  return lines;
}

const STATUS_LABEL: Record<CheckOutcome["status"], string> = {
  passed: "✅ passed",
  failed: "❌ failed",
  unavailable: "⚪ unavailable",
};

export function anyCheckFailed(outcomes: readonly CheckOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === "failed");
}

export function buildPrTitle(issueNumber: number, issueTitle: string): string {
  return `fix #${issueNumber}: ${issueTitle}`;
}

export function buildPrBody(params: {
  issueNumber: number;
  verification: readonly CheckOutcome[];
  stackedOn?: { prNumber: number; branch: string };
  runUrl?: string;
  /** Outcome of the CI-gated fix loop; omitted before CI has been consulted. */
  ci?: CiGateSummary;
}): string {
  const lines: string[] = [];
  if (params.stackedOn) {
    lines.push(
      `> [!IMPORTANT]`,
      `> Stacked on #${params.stackedOn.prNumber} (\`${params.stackedOn.branch}\`) - merge that first.`,
      ``,
    );
  }
  lines.push(`Closes #${params.issueNumber}.`, ``);

  if (params.ci !== undefined) {
    lines.push(...renderCiSection(params.ci));
  }

  lines.push(
    `## Local pre-check`,
    ``,
    `A fast smoke test from \`.fixowl.yml\`; the base branch's CI is the authority for this PR.`,
    ``,
  );
  if (params.verification.length === 0) {
    lines.push(`No verification is configured for this repository (\`.fixowl.yml\`).`);
  } else {
    lines.push(`| check | result |`, `| --- | --- |`);
    for (const outcome of params.verification) {
      const detail = outcome.detail ? ` (${outcome.detail})` : "";
      lines.push(`| ${outcome.name} | ${STATUS_LABEL[outcome.status]}${detail} |`);
    }
  }
  lines.push(``);

  if (params.runUrl) {
    lines.push(
      `Screenshots and logs are in the \`fixowl-evidence\` artifact of [this run](${params.runUrl}).`,
      ``,
    );
  }
  lines.push(
    `---`,
    `🦉 Opened by [fixowl](https://github.com/NachoPal/fixowl). Review before merging; fixowl never merges.`,
  );
  return lines.join("\n") + "\n";
}
