import type { Prompter } from "../prompt.ts";
import type { ActionVersionChoice } from "./repo-provisioning.ts";

/**
 * The non-interactive `--action-version <ref>` flag. `main` (moving ref) and
 * `cli` (this CLI's release, the default, with dev/source-build fallback) are
 * reserved keywords; anything else is taken as an explicit tag to pin (hard-
 * fails at resolution if it does not exist). Pure so it stays unit-testable.
 */
export function parseActionVersionFlag(value: string, cliVersion: string): ActionVersionChoice {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "") {
    throw new Error("--action-version needs a value: a tag (e.g. v0.2.0-rc.9), `main`, or `cli`");
  }
  if (lower === "main") return { kind: "main" };
  if (lower === "cli" || lower === "release" || lower === "default") {
    return { kind: "cli-release", cliVersion };
  }
  return { kind: "tag", tag: trimmed };
}

/**
 * Asks the one-time "which fixowl action version should the workflow pin to?"
 * question. Interactive counterpart to `parseActionVersionFlag`; the resolution
 * (tag -> SHA, main -> moving ref) happens later in `resolveActionRef`.
 */
export async function promptActionVersion(
  prompter: Prompter,
  cliVersion: string,
): Promise<ActionVersionChoice> {
  const kind = await prompter.choose<"cli-release" | "tag" | "main">(
    "Which fixowl action version should the workflow pin to?",
    [
      {
        value: "cli-release",
        label: `This CLI's release (v${cliVersion})`,
        hint: "recommended - pins the matching release's immutable SHA",
      },
      {
        value: "tag",
        label: "A specific release / RC tag",
        hint: "you type it, e.g. v0.2.0-rc.9",
      },
      {
        value: "main",
        label: "main (always latest)",
        hint: "moving ref; for fixowl's own self-run repo",
      },
    ],
  );
  if (kind === "cli-release") return { kind: "cli-release", cliVersion };
  if (kind === "main") return { kind: "main" };
  const tag = (await prompter.ask("Action tag to pin (e.g. v0.2.0-rc.9)")).trim();
  return { kind: "tag", tag };
}
