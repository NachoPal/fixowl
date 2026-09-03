/**
 * Layer 2 merge: overlay the LLM's conflict groups (`classify.ts` chains) on top
 * of the Layer-1 prerequisite edges under a strict "prerequisites always win" rule.
 *
 * Both inputs range over the shippable set S' (deferred issues are already gone).
 * - `conflictChains`: the LLM's same-files grouping, a partition of S', each inner
 *   array in intended fix order. Purely heuristic.
 * - `prereqs`: for each issue, its in-set prerequisite predecessors (hard).
 *
 * Rules:
 * - A prereq forces its two issues into one chain, ordered prereq-first, even if the
 *   LLM called them independent.
 * - Within a chain, prereq edges dictate order; ties fall back to the LLM's own order.
 * - With no prereq edges the output equals `conflictChains` byte-for-byte (the
 *   additive/regression guarantee).
 */
export function mergeGraphs(
  conflictChains: readonly (readonly number[])[],
  prereqs: Map<number, number[]>,
): number[][] {
  const all = conflictChains.flat();
  // Stable position from the LLM output: chain 0 members in order, then chain 1, ...
  // This is the tiebreak that preserves LLM ordering when no prereq says otherwise,
  // and the component order that preserves chain identity when nothing merges.
  const position = new Map<number, number>();
  all.forEach((n, i) => position.set(n, i));

  // Union-find: same conflict chain OR a prereq edge => same final chain.
  const parent = new Map<number, number>();
  for (const n of all) parent.set(n, n);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as number;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const chain of conflictChains) {
    for (let i = 1; i < chain.length; i++) union(chain[0] as number, chain[i] as number);
  }
  for (const [dependent, preds] of prereqs) {
    if (!position.has(dependent)) continue;
    for (const pred of preds) {
      if (position.has(pred)) union(dependent, pred);
    }
  }

  // Group members by component; order components by their smallest position so
  // an unmerged run reproduces the original chain order exactly.
  const components = new Map<number, number[]>();
  for (const n of all) {
    const root = find(n);
    const bucket = components.get(root);
    if (bucket === undefined) components.set(root, [n]);
    else bucket.push(n);
  }
  const ordered = [...components.values()].toSorted(
    (a, b) => minPosition(a, position) - minPosition(b, position),
  );
  return ordered.map((members) => orderWithinChain(members, prereqs, position));
}

function minPosition(members: readonly number[], position: Map<number, number>): number {
  return Math.min(...members.map((n) => position.get(n) ?? 0));
}

/**
 * Topo-sort one chain's members by prereq edges (restricted to the chain),
 * tiebreaking by LLM position. Prereq order overrides LLM order; with no prereq
 * edges the members come out in their original LLM order.
 */
function orderWithinChain(
  members: readonly number[],
  prereqs: Map<number, number[]>,
  position: Map<number, number>,
): number[] {
  const inChain = new Set(members);
  const inDegree = new Map<number, number>();
  for (const n of members) {
    inDegree.set(n, (prereqs.get(n) ?? []).filter((p) => inChain.has(p)).length);
  }
  const ready = members.filter((n) => (inDegree.get(n) ?? 0) === 0);
  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const n = ready.shift() as number;
    order.push(n);
    for (const m of members) {
      if ((prereqs.get(m) ?? []).includes(n)) {
        const d = (inDegree.get(m) ?? 0) - 1;
        inDegree.set(m, d);
        if (d === 0) ready.push(m);
      }
    }
  }
  return order;
}
