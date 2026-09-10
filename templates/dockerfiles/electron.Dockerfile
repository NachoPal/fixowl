# Sample fixowl Dockerfile for an Electron app: verification runs against a
# virtual display (Xvfb); Playwright drives Electron directly.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    dbus-x11 \
    libasound2t64 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

# Coding agent CLIs. Install the one for whichever agent this repo runs:
#   agent: claude -> the `claude` CLI (@anthropic-ai/claude-code)
#   agent: codex  -> the `codex` CLI (@openai/codex), which needs OPENAI_API_KEY
#                    opted into the repo's agent env (see .fixowl.yml)
# Both are installed here so this image supports either agent with no edits.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace

# Wrap verify commands with xvfb-run in .fixowl.yml, e.g.:
#   checks:
#     - { name: e2e, run: "xvfb-run -a npm run test:e2e" }
