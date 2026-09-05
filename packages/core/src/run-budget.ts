/**
 * Layered run-budgets (issue #21): the night is bounded not by a single fixed
 * "max issues" cap but by a small set of independent, each-optional stop
 * conditions evaluated at two gates (pre-run and between-issues). The run stops
 * on the FIRST condition that trips.
 *
 * Three orthogonal axes, each opted out by leaving its limit `undefined`:
 * - count       (`maxIssues`)     - how MANY PRs may ship. The kept secondary cap.
 * - usage %     (`usagePercent`)  - how much of the subscription window is spent
 *                                   (the flagship). Abstains when usage is
 *                                   unobservable this run, so it never aborts a
 *                                   night that count + wall-clock would allow.
 * - wall-clock  (`runMinutes`)    - how LONG the night runs; a graceful "don't
 *                                   start a new issue after N minutes", distinct
 *                                   from the workflow's blunt `timeout-minutes`.
 *
 * This module is pure (no I/O): the gate in `main.ts` assembles a `BudgetState`
 * snapshot (shipped count, elapsed wall-clock, latest usage read) and calls
 * `evaluateBudget`. That keeps trip/no-trip and first-trip-wins ordering unit-
 * testable like `prereq-planner`/`classify`, and leaves concurrency-safety to
 * the state assembly if/when parallel chains land (issue #36): the conditions
 * stay pure; only the snapshot must be consistent.
 */

import type { UsageSnapshot } from "./agent-usage.ts";

/** The three stop-condition axes, in first-trip-wins evaluation order. */
export type BudgetConditionName = "count" | "usage" | "wallclock";

/** A consistent snapshot of the run's progress at one gate. */
export interface BudgetState {
  /** Issues that have opened a PR so far tonight. */
  shipped: number;
  /** Milliseconds since the night started (wall clock). */
  elapsedMs: number;
  /** Latest usage snapshot, or undefined if unobservable / unread this run. */
  usage: UsageSnapshot | undefined;
}

/** Each limit is optional; `undefined` opts its condition out entirely. */
export interface BudgetLimits {
  maxIssues?: number;
  usagePercent?: number;
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
 * evaluation order count -> usage -> wall-clock. An undefined limit omits its
 * condition, so an all-undefined budget yields an empty list ("never stops on a
 * budget"), which is exactly the pre-#21 behavior.
 */
export function buildStopConditions(limits: BudgetLimits): StopCondition[] {
  const conditions: StopCondition[] = [];

  if (limits.maxIssues !== undefined) {
    const cap = limits.maxIssues;
    conditions.push({
      name: "count",
      evaluate: (state) =>
        state.shipped >= cap
          ? {
              stop: true,
              condition: "count",
              reason: `count budget reached: ${state.shipped} issue(s) shipped (cap ${cap})`,
            }
          : { stop: false },
    });
  }

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
