export interface CheckOutcome {
  name: string;
  status: "passed" | "failed" | "unavailable";
  detail?: string;
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

  lines.push(`## Verification`, ``);
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
