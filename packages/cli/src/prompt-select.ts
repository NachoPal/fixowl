/**
 * Pure logic behind the arrow-key selector in `prompt.ts`: key handling,
 * viewport windowing, rendering and the typed fallback's number parsing.
 *
 * Hand-rolled on purpose. The prompter stays dependency-free (the CLI ships as
 * a single bundled file), so instead of a TUI prompt library this reads node's
 * own readline `keypress` events and reduces them here, where the interaction
 * can be tested without a TTY. `prompt.ts` owns the I/O: muting readline's
 * echo, painting the block and moving the cursor.
 */

export interface SelectChoiceView {
  label: string;
  hint?: string;
}

export interface SelectState {
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
}

/** The part of node's readline keypress event the selector reacts to. */
export interface SelectKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export interface SelectRules {
  count: number;
  /** Checkbox mode: space toggles, enter submits every checked row. */
  multi: boolean;
  /** Minimum checked rows a multi-select accepts on submit. */
  min: number;
}

export type SelectOutcome =
  | { kind: "update"; state: SelectState }
  | { kind: "submit"; state: SelectState }
  /** Submit refused; the message is shown under the list until the next key. */
  | { kind: "refuse"; message: string }
  | { kind: "ignore" };

export const HIDE_CURSOR = "\u001B[?25l";
export const SHOW_CURSOR = "\u001B[?25h";

/**
 * The prelude to a repaint: move back up over the block painted last time and
 * erase from the cursor to the end of the screen.
 */
export function repaintPrefix(previousLines: number): string {
  return `${previousLines > 0 ? `\u001B[${previousLines}A` : ""}\u001B[0J`;
}

/** Physical lines a painted block occupies (it always ends in a newline). */
export function paintedLines(block: string): number {
  return block.split("\n").length - 1;
}

function wrap(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

function toggle(selected: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(index)) next.add(index);
  return next;
}

function allIndices(count: number): Set<number> {
  return new Set(Array.from({ length: count }, (_, index) => index));
}

/**
 * One keypress against the current selection. Every branch is total: an
 * unrecognised key is `ignore`, so stray escape sequences cannot corrupt the
 * state or trigger a submit.
 */
export function applySelectKey(
  state: SelectState,
  key: SelectKey,
  rules: SelectRules,
): SelectOutcome {
  const move = (delta: number): SelectOutcome => ({
    kind: "update",
    state: { ...state, cursor: wrap(state.cursor + delta, rules.count) },
  });
  const jump = (cursor: number): SelectOutcome => ({ kind: "update", state: { ...state, cursor } });
  const name = key.name ?? "";

  if (key.ctrl === true) {
    if (name === "n") return move(1);
    if (name === "p") return move(-1);
    return { kind: "ignore" };
  }

  switch (name) {
    case "down":
    case "j":
      return move(1);
    case "up":
    case "k":
      return move(-1);
    case "tab":
      return move(key.shift === true ? -1 : 1);
    case "home":
      return jump(0);
    case "end":
      return jump(Math.max(0, rules.count - 1));
    case "space":
      if (!rules.multi) return { kind: "ignore" };
      return {
        kind: "update",
        state: { ...state, selected: toggle(state.selected, state.cursor) },
      };
    case "a": {
      if (!rules.multi) return { kind: "ignore" };
      const all = state.selected.size === rules.count;
      return {
        kind: "update",
        state: { ...state, selected: all ? new Set() : allIndices(rules.count) },
      };
    }
    case "return":
    case "enter":
      if (rules.multi && state.selected.size < rules.min) {
        return {
          kind: "refuse",
          message:
            rules.min === 1
              ? "select at least one with space"
              : `select at least ${rules.min} with space`,
        };
      }
      return { kind: "submit", state };
    default: {
      // Digits keep the muscle memory of the old numbered prompts: they jump
      // the cursor, they never submit on their own.
      if (/^[1-9]$/.test(name)) {
        const index = Number(name) - 1;
        return index < rules.count ? jump(index) : { kind: "ignore" };
      }
      return { kind: "ignore" };
    }
  }
}

/** The slice of rows to paint, keeping the cursor roughly centred. */
export function selectWindow(
  cursor: number,
  count: number,
  maxRows: number,
): { start: number; end: number } {
  if (count <= maxRows) return { start: 0, end: count };
  const half = Math.floor(maxRows / 2);
  const start = Math.min(Math.max(cursor - half, 0), count - maxRows);
  return { start, end: start + maxRows };
}

/** Clips a line to the terminal width so no row wraps and desyncs the repaint. */
export function clip(line: string, width: number): string {
  const limit = Math.max(8, width - 1);
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

export interface RenderOptions {
  multi: boolean;
  /** Terminal columns; rows are clipped to fit on one physical line. */
  width: number;
  maxRows: number;
  notice?: string;
}

/**
 * The whole selector block, ending in a newline. Every row is exactly one
 * physical line, so `prompt.ts` can repaint by moving up that many lines.
 */
export function renderSelect(
  question: string,
  choices: readonly SelectChoiceView[],
  state: SelectState,
  options: RenderOptions,
): string {
  const lines = question.split("\n");
  const { start, end } = selectWindow(state.cursor, choices.length, options.maxRows);
  if (start > 0) lines.push(`    ⋯ ${start} more above`);
  for (let index = start; index < end; index++) {
    const choice = choices[index];
    if (choice === undefined) continue;
    const pointer = index === state.cursor ? "❯" : " ";
    const box = options.multi ? (state.selected.has(index) ? "◉ " : "◯ ") : "";
    const hint = choice.hint !== undefined ? ` - ${choice.hint}` : "";
    lines.push(`  ${pointer} ${box}${choice.label}${hint}`);
  }
  if (end < choices.length) lines.push(`    ⋯ ${choices.length - end} more below`);
  if (options.notice !== undefined) lines.push(`  ! ${options.notice}`);
  lines.push(
    options.multi
      ? "    ↑/↓ move · space select · a all · enter confirm"
      : "    ↑/↓ move · enter confirm",
  );
  return `${lines.map((line) => clip(line, options.width)).join("\n")}\n`;
}

/**
 * The typed fallback for a checkbox prompt (no TTY): a list of 1-based row
 * numbers, comma- or space-separated. Returns the problem to show instead when
 * the answer is unusable.
 */
export function parseIndexList(
  answer: string,
  count: number,
  min: number,
): { indices: number[] } | { problem: string } {
  const trimmed = answer.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return min === 0 ? { indices: [] } : { problem: `enter at least ${min} number(s)` };
  }
  const indices: number[] = [];
  for (const token of trimmed.split(/[\s,]+/)) {
    const value = Number(token);
    if (!Number.isInteger(value) || value < 1 || value > count) {
      return { problem: `"${token}" is not a number between 1 and ${count}` };
    }
    if (!indices.includes(value - 1)) indices.push(value - 1);
  }
  if (indices.length < min) return { problem: `enter at least ${min} number(s)` };
  return { indices: indices.toSorted((a, b) => a - b) };
}
