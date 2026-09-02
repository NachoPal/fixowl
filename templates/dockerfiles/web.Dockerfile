# Sample fixowl Dockerfile for a Node web app, with Playwright for verification
# evidence. Adapt versions to your repo and keep it versioned with your code.
#
# The Playwright base image bundles chromium and every system dependency, so
# `verify.web` screenshots work out of the box.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# The coding agent CLI (swap for your agent of choice)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Warm the dependency cache so overnight runs skip cold installs. The repo is
# volume-mounted over /workspace at runtime; this layer only caches the store.
COPY package.json package-lock.json* ./
RUN npm ci || true
