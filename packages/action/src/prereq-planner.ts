import type { IssueDeps, IssueLite } from "./deps.ts";

/**
 * Layer 1 (authoritative): enforce the native GitHub `blockedBy` prerequisite
 * edges over tonight's selected set. A dependent stacks on and is ordered after
 * its prerequisite when that prerequisite is *also* shipping tonight; otherwise
 * the dependent is DEFERRED (not rebased-to-default like a conflict chain).
 *
 * Pure: the only I/O is the read-only fetch behind `GitHubApi.getIssueDependencies`,
 * whose result is passed in here as `deps`.
 *
 * Rules (all locked captain decisions):
 * - A CLOSED blocker counts as satisfied (GitHub's semantics), regardless of repo.
 * - An OPEN blocker that is not in tonight's shippable set - not selected, or in
 *   another repo - defers the dependent.
 * - Deferral cascades: if a prerequisite is itself deferred, its dependents defer too.
 * - A dependency cycle defers the whole cycle with a warning; no ordering is emitted.
 * - `>50` blockers (overflow) conservatively defers the issue.
 * - `parent`/sub-issue edges are intentionally ignored for ordering.
 */

export interface DeferredIssue {
  issue: IssueLite;
  reason: string;
}

export interface PrereqPlan {
  /** Shippable issues (selected minus deferred), in prerequisite-respecting topo order, oldest-first tiebreak. */
  shippable: IssueLite[];
  /** For each shippable issue number, its in-set prerequisites (predecessors that must ship first). */
  prereqs: Map<number, number[]>;
  deferred: DeferredIssue[];
  warnings: string[];
}

export function planPrereqs(
  selected: readonly IssueLite[],
  deps: Map<number, IssueDeps>,
  currentRepo: string,
): PrereqPlan {
  const byNumber = new Map(selected.map((issue) => [issue.number, issue]));
  const selectedNumbers = new Set(byNumber.keys());
  const warnings: string[] = [];

  // Reasons an issue is blocked directly (before cascade/cycle propagation).
  const directDeferReason = new Map<number, string>();
  // In-set prerequisite predecessors: dependent -> [prerequisite, ...].
  const inSetPrereqs = new Map<number, number[]>();
  for (const issue of selected) inSetPrereqs.set(issue.number, []);

  for (const issue of selected) {
    const issueDeps = deps.get(issue.number);
    if (issueDeps === undefined) continue;
    if (issueDeps.blockedByOverflow === true) {
      directDeferReason.set(
        issue.number,
        "has more blockers than could be read (over 50); deferred conservatively",
      );
    }
    for (const edge of issueDeps.blockedBy) {
      if (edge.state === "CLOSED") continue; // closed blocker == satisfied
      if (edge.repo !== currentRepo) {
        directDeferReason.set(
          issue.number,
          `blocked by #${edge.number} in another repository (${edge.repo}), which fixowl cannot ship tonight`,
        );
        continue;
      }
      if (selectedNumbers.has(edge.number)) {
        inSetPrereqs.get(issue.number)?.push(edge.number);
      } else {
        directDeferReason.set(
          issue.number,
          `blocked by #${edge.number}, which is not in tonight's shippable set`,
        );
      }
    }
  }

  // Detect cycles among the in-set prerequisite edges (Kahn: nodes that never
  // reach in-degree 0 are on a cycle). Cyclic nodes are deferred as a group.
  const cycleNodes = findCycleNodes(selectedNumbers, inSetPrereqs);
  if (cycleNodes.size > 0) {
    const members = [...cycleNodes].toSorted((a, b) => a - b);
    warnings.push(
      `issues ${members.map((n) => `#${n}`).join(", ")} form a dependency cycle; deferred (no valid order)`,
    );
    for (const n of cycleNodes) {
      directDeferReason.set(n, "part of a dependency cycle");
    }
  }

  // Propagate deferral to dependents of any deferred issue (fixpoint).
  const deferReason = new Map(directDeferReason);
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of selected) {
      if (deferReason.has(issue.number)) continue;
      for (const prereq of inSetPrereqs.get(issue.number) ?? []) {
        if (deferReason.has(prereq)) {
          deferReason.set(
            issue.number,
            `prerequisite #${prereq} is deferred and will not ship tonight`,
          );
          changed = true;
          break;
        }
      }
    }
  }

  const deferred: DeferredIssue[] = [];
  for (const issue of selected) {
    const reason = deferReason.get(issue.number);
    if (reason !== undefined) deferred.push({ issue, reason });
  }

  // Shippable set S': selected minus deferred. Topo-sort by the in-set prereq
  // edges, tiebreaking oldest-first (issue number) to keep behavior stable.
  const shippableNumbers = new Set(
    selected.map((i) => i.number).filter((n) => !deferReason.has(n)),
  );
  const prereqs = new Map<number, number[]>();
  for (const n of shippableNumbers) {
    prereqs.set(
      n,
      (inSetPrereqs.get(n) ?? []).filter((p) => shippableNumbers.has(p)),
    );
  }
  const order = topoSortOldestFirst(shippableNumbers, prereqs);
  const shippable = order
    .map((n) => byNumber.get(n))
    .filter((i): i is IssueLite => i !== undefined);

  return { shippable, prereqs, deferred, warnings };
}

/** Nodes that never reach in-degree 0 under Kahn's algorithm are on a cycle. */
function findCycleNodes(nodes: ReadonlySet<number>, prereqs: Map<number, number[]>): Set<number> {
  const inDegree = new Map<number, number>();
  for (const n of nodes) inDegree.set(n, 0);
  for (const n of nodes) {
    for (const p of prereqs.get(n) ?? []) {
      if (nodes.has(p)) inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
    }
  }
  const queue = [...nodes].filter((n) => (inDegree.get(n) ?? 0) === 0);
  const settled = new Set<number>();
  while (queue.length > 0) {
    const n = queue.shift() as number;
    settled.add(n);
    // Removing n decrements the in-degree of every node it is a prerequisite of.
    for (const m of nodes) {
      if ((prereqs.get(m) ?? []).includes(n)) {
        const d = (inDegree.get(m) ?? 0) - 1;
        inDegree.set(m, d);
        if (d === 0) queue.push(m);
      }
    }
  }
  const cyclic = new Set<number>();
  for (const n of nodes) if (!settled.has(n)) cyclic.add(n);
  return cyclic;
}

/** Kahn's topo sort; among ready nodes always pick the smallest issue number. */
function topoSortOldestFirst(nodes: ReadonlySet<number>, prereqs: Map<number, number[]>): number[] {
  const inDegree = new Map<number, number>();
  for (const n of nodes) inDegree.set(n, (prereqs.get(n) ?? []).filter((p) => nodes.has(p)).length);
  const ready = [...nodes].filter((n) => (inDegree.get(n) ?? 0) === 0);
  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const n = ready.shift() as number;
    order.push(n);
    for (const m of nodes) {
      if ((prereqs.get(m) ?? []).includes(n)) {
        const d = (inDegree.get(m) ?? 0) - 1;
        inDegree.set(m, d);
        if (d === 0) ready.push(m);
      }
    }
  }
  return order;
}
