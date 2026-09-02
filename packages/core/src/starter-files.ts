/**
 * Starter files fixowl proposes to target repos (via PR) when missing. The
 * copies under templates/ in this repo are generated from these constants;
 * starter-files.test.ts keeps them in sync.
 */

export const STARTER_REPO_CONFIG = `# fixowl per-repo config. Versioned with your code; evolve it via normal PRs.
version: 1

# Image the coding agent and verification run in. Must contain: the agent CLI,
# git, your toolchain, and (for web verification) Playwright + chromium.
dockerfile: Dockerfile

verify:
  # Commands run in a fresh container after the agent finishes. Any failure
  # turns the PR into a draft.
  checks:
    - { name: tests, run: "npm test" }
  # Optional: start the app, wait for the URL, capture a screenshot as PR
  # evidence. Requires playwright in the image; degrades to "unavailable".
  # web:
  #   - { name: app, start: "npm run dev", url: "http://localhost:5173/" }

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
