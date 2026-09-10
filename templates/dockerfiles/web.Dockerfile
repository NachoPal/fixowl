# Sample fixowl Dockerfile for a Node web app, with Playwright for verification
# evidence. Adapt versions to your repo and keep it versioned with your code.
#
# The Playwright base image bundles chromium and every system dependency, so
# `verify.web` screenshots work out of the box.
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
