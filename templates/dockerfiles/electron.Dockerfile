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

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Wrap verify commands with xvfb-run in .fixowl.yml, e.g.:
#   checks:
#     - { name: e2e, run: "xvfb-run -a npm run test:e2e" }
