# Optional sample fixowl Dockerfile for a Node web app, bundled with Playwright.
# fixowl has no built-in browser step; this is just a convenient base if you want
# to run a browser-based check yourself. The Playwright base image ships chromium
# and every system dependency, so a `verify.checks` entry that drives a browser
# (e.g. a screenshot script) works out of the box - see .fixowl.yml. Adapt
# versions to your repo and keep it versioned with your code.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# Coding agent CLIs. Install the one for whichever agent this repo runs:
#   agent: claude -> the `claude` CLI (@anthropic-ai/claude-code)
#   agent: codex  -> the `codex` CLI (@openai/codex), which needs OPENAI_API_KEY
#                    opted into the repo's agent env (see .fixowl.yml)
# Both are installed here so this image supports either agent with no edits.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace

# Warm the dependency cache so overnight runs skip cold installs. The repo is
# volume-mounted over /workspace at runtime; this layer only caches the store.
COPY package.json package-lock.json* ./
RUN npm ci || true
