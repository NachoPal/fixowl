/**
 * Layered run-budgets (issue #21): the night is bounded not by a single fixed
 * "max issues" cap but by a small set of independent, each-optional stop
 * conditions evaluated at two gates (pre-run and between-issues). The run stops
 * on the FIRST condition that trips.
 *
 * Three orthogonal axes, each opted out by leaving its limit `undefined`:
 *
 * NOTE (issue #82): how MANY PRs may ship is NOT one of them. `max_issues_per_run`
 * is a pure SELECTION cap applied before the loop (main.ts), never a stop
 * condition: the loop can only ever reach it by shipping every selected issue, so
 * a count condition here could never trip. It was removed as dead code.
 *
 * - usage %     (`usagePercent`)  - how much of the SUBSCRIPTION window is spent
 *                                   (the flagship, for subscription-billed agents
 *                                   like claude). Abstains when usage is
 *                                   unobservable this run, so it never aborts a
 *                                   night that wall-clock alone would allow.
 * - tokens      (`totalTokens`)   - the total TOKENS an API-credit agent (codex,
 *                                   or claude on an API key) may spend; the
 *                                   API-credit counterpart to usage %. Measured
 *                                   IN-BAND (accumulated
 *                                   from the agent's own reported token usage,
 *                                   see agent-spend.ts), not from a provider
 *                                   endpoint. Abstains when the agent's spend is
 *                                   unmeasurable this run, exactly like usage %.
 * - wall-clock  (`runMinutes`)    - how LONG the night runs; a graceful "don't
 *                                   start a new issue after N minutes", distinct
 *                                   from the workflow's blunt `timeout-minutes`.
 *
 * This module is pure (no I/O): the gate in `main.ts` assembles a `BudgetState`
 * snapshot (elapsed wall-clock, latest usage read, accumulated tokens) and calls `evaluateBudget`. That keeps trip/no-trip and first-trip-wins
 * ordering unit-testable like `prereq-planner`/`classify`, and leaves
 * concurrency-safety to the state assembly if/when parallel chains land (issue
 * #36): the conditions stay pure; only the snapshot must be consistent.
 */

import type { UsageSnapshot } from "./agent-usage.ts";

/** The stop-condition axes, in first-trip-wins evaluation order. */
export type BudgetConditionName = "usage" | "tokens" | "wallclock";

/** A consistent snapshot of the run's progress at one gate. */
export interface BudgetState {
  /** Milliseconds since the night started (wall clock). */
  elapsedMs: number;
  /** Latest usage snapshot, or undefined if unobservable / unread this run. */
  usage: UsageSnapshot | undefined;
  /**
   * Total tokens the agent has spent so far tonight, accumulated in-band from
   * its reported usage; `undefined` when the agent's spend is unmeasurable this
   * run (the token condition then abstains, exactly like `usage`).
   */
  tokensUsed: number | undefined;
}

/** Each limit is optional; `undefined` opts its condition out entirely. */
export interface BudgetLimits {
  usagePercent?: number;
  /** Total-token hard cap for an API-credit agent (issue: API-credit spend cap). */
  totalTokens?: number;
  runMinutes?: number;
}

export type BudgetVerdict =
  | { stop: false }
  | { stop: true; condition: BudgetConditionName; reason: string };

/** One orthogonal stop condition. */
export interface StopCondition {
  name: BudgetConditionName;
  evaluate(state: BudgetState): BudgetVerdict;
}

/**
 * Build the active stop conditions from the configured limits, in the fixed
 * evaluation order usage -> tokens -> wall-clock. An undefined limit omits its
 * condition, so an all-undefined budget yields an empty list ("never stops on a
 * budget"), which is exactly the pre-#21 behavior.
 */
export function buildStopConditions(limits: BudgetLimits): StopCondition[] {
  const conditions: StopCondition[] = [];

  if (limits.usagePercent !== undefined) {
    const budget = limits.usagePercent;
    conditions.push({
      name: "usage",
      evaluate: (state) => {
        // Abstain when usage is unobservable: fail-open for the read, so an
        // unreadable window never aborts a night the other caps would allow.
        if (state.usage === undefined) return { stop: false };
        if (state.usage.usedPercent < budget) return { stop: false };
        return {
          stop: true,
          condition: "usage",
          reason: `usage budget reached: ${state.usage.limiting} window at ${formatPercent(
            state.usage.usedPercent,
          )}% (budget ${budget}%)`,
        };
      },
    });
  }

  if (limits.totalTokens !== undefined) {
    const cap = limits.totalTokens;
    conditions.push({
      name: "tokens",
      evaluate: (state) => {
        // Abstain when spend is unmeasurable this run: fail-open like usage, so
        // an agent that reports no usage never aborts a night the other caps
        // would allow. At the pre-run gate tokensUsed is 0, so this never trips
        // there.
        if (state.tokensUsed === undefined) return { stop: false };
        if (state.tokensUsed < cap) return { stop: false };
        return {
          stop: true,
          condition: "tokens",
          reason: `token budget reached: ${state.tokensUsed} token(s) spent (cap ${cap})`,
        };
      },
    });
  }

  if (limits.runMinutes !== undefined) {
    const budgetMs = limits.runMinutes * 60_000;
    const runMinutes = limits.runMinutes;
    conditions.push({
      name: "wallclock",
      evaluate: (state) =>
        state.elapsedMs >= budgetMs
          ? {
              stop: true,
              condition: "wallclock",
              reason: `run budget reached: ${Math.floor(
                state.elapsedMs / 60_000,
              )} min elapsed (budget ${runMinutes} min); not starting another issue`,
            }
          : { stop: false },
    });
  }

  return conditions;
}

/**
 * Evaluate every condition in order; the FIRST to trip stops the loop. Order is
 * deterministic (the `buildStopConditions` order), so when two conditions trip on
 * the same snapshot the earlier-ordered one is reported.
 */
export function evaluateBudget(
  conditions: readonly StopCondition[],
  state: BudgetState,
): BudgetVerdict {
  for (const condition of conditions) {
    const verdict = condition.evaluate(state);
    if (verdict.stop) return verdict;
  }
  return { stop: false };
}

/** One decimal at most, no trailing ".0", so "85" and "85.4" both read cleanly. */
function formatPercent(value: number): string {
  return Number(value.toFixed(1)).toString();
}
