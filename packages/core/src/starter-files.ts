/**
 * Starter files fixowl proposes to target repos (via PR) when missing. The
 * copies under templates/ in this repo are generated from these constants;
 * starter-files.test.ts keeps them in sync.
 */

export const STARTER_REPO_CONFIG = `# fixowl per-repo config. Versioned with your code; evolve it via normal PRs.
version: 1

# Image the coding agent and verification run in. Must contain: the agent CLI,
# git, and your toolchain (plus whatever your verify commands need).
dockerfile: Dockerfile

verify:
  # Commands run in a fresh container after the agent finishes, as a cheap
  # pre-filter: if they fail, fixowl feeds the output back to the agent and
  # retries without pushing (no CI spend). They do not decide ready-vs-draft -
  # the target repo's required CI does that. fixowl runs the commands you
  # declare here and stays agnostic about *how* the change is verified.
  checks:
    - { name: tests, run: "npm test" }
  # Want a browser screenshot? Bring it yourself: add Playwright to your image
  # (see templates/dockerfiles/web.Dockerfile) and drive it from a normal check,
  # e.g. { name: screenshot, run: "node scripts/screenshot.mjs" }.

# Extra instructions appended to every fix prompt for this repo.
# prompt_extra: |
#   Conventions the agent must follow in this repo.
`;

export const STARTER_ISSUE_TEMPLATE = `name: Overnight fix
description: File an issue for fixowl to fix tonight
labels: [overnight]
body:
  - type: markdown
    attributes:
      value: |
        🦉 This issue will be picked up by fixowl on the next scheduled run.
        Write it for an unattended coding agent: concrete, self-contained, verifiable.
  - type: textarea
    id: problem
    attributes:
      label: What is wrong
      description: Current behavior, and where (files, screens, commands).
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: What should happen instead
      description: Expected behavior, precisely enough to verify.
    validations:
      required: true
  - type: textarea
    id: hints
    attributes:
      label: Hints (optional)
      description: Suspected cause, relevant modules, constraints.
`;

export const STARTER_ISSUE_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/fixowl-overnight.yml";
