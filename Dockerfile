# fixowl image for this repo. The coding agent and the verify checks both run
# inside this container. fixowl is a pnpm TypeScript monorepo with no web app,
# so - unlike templates/dockerfiles/web.Dockerfile - there is nothing to
# screenshot and no Playwright/chromium is needed. Keep this minimal: it only
# has to run `pnpm install`, `pnpm lint`, and `pnpm test`, plus the `claude`
# CLI the agent adapter execs in-container.
#
# Versioned with the repo; evolve it via normal PRs.

# Node 24 to match the repo's engines (">=24") and CI (setup-node node-version:
# 24). The bookworm-slim variant keeps the image small while still providing a
# glibc userland for native toolchains.
FROM node:24-bookworm-slim

# git is expected by the toolchain in the working tree. (Commits and pushes
# happen on the host, outside the container, per fixowl's security model.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

# pnpm, pinned to the repo's packageManager (root package.json). corepack ships
# with Node and activates the exact version, so the image and CI agree.
RUN corepack enable \
  && corepack prepare pnpm@11.25.0 --activate

# The coding agent CLI (Claude Code); the adapter execs `claude` in-container.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
