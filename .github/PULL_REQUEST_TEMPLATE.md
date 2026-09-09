<!--
Thanks for contributing to fixowl! Please read CONTRIBUTING.md if you haven't.
Keep this description human-readable: what changed and why.
-->

## What & why

<!-- A short summary of the change and the motivation. -->

Closes #<!-- issue number -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] New coding-agent / model adapter
- [ ] Docs only
- [ ] Refactor / chore

## Checklist

- [ ] `pnpm lint` passes.
- [ ] `pnpm test` passes.
- [ ] If I changed code the action bundles, I ran `pnpm build` and committed the
      updated `dist/`.
- [ ] Any new workflow actions are SHA-pinned with a `# vN` comment.
- [ ] I did not weaken any [hard invariant](../CONTRIBUTING.md#hard-invariants-do-not-break-these)
      (never-merge; agent stays credential-less; `.git` never enters a container;
      one level of containerization; non-root containers).
- [ ] This is a single, focused branch (fixowl is squash-merge only; no stacking
      on another open PR).

## For a new adapter (delete if N/A)

<!-- See docs/adding-an-agent-adapter.md -->

- [ ] Added the adapter to `packages/core/src/agent-adapters.ts` and registered
      it in `ADAPTERS`.
- [ ] Added its models/efforts to `AGENT_MODEL_CATALOG`
      (`packages/core/src/agent-catalog.ts`), or explained why it has no entry.
- [ ] The env allowlist is correct (empty default for a paid agent; never a
      GitHub credential).
- [ ] Added unit tests (argv, `promptVia`, `env`, config-override path) and
      updated the `agentAdapterNames()` assertion.
- [ ] Ran a real end-to-end fix with the agent, or noted that I could not.
