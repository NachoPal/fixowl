import { describe, expect, it } from "vitest";
import {
  applySelectKey,
  clip,
  paintedLines,
  parseIndexList,
  renderSelect,
  repaintPrefix,
  selectWindow,
  type SelectKey,
  type SelectOutcome,
  type SelectRules,
  type SelectState,
} from "./prompt-select.ts";

const ESC = String.fromCharCode(27);

const single: SelectRules = { count: 4, multi: false, min: 1 };
const multi: SelectRules = { count: 4, multi: true, min: 1 };

function state(cursor: number, selected: number[] = []): SelectState {
  return { cursor, selected: new Set(selected) };
}

/** The state a key produces, for the outcomes that carry one. */
function after(from: SelectState, key: SelectKey, rules: SelectRules): SelectState {
  const outcome = applySelectKey(from, key, rules);
  if (outcome.kind !== "update" && outcome.kind !== "submit") {
    throw new Error(`expected a state, got ${outcome.kind}`);
  }
  return outcome.state;
}

describe("applySelectKey navigation", () => {
  it("moves down and wraps past the last row", () => {
    expect(after(state(0), { name: "down" }, single).cursor).toBe(1);
    expect(after(state(3), { name: "down" }, single).cursor).toBe(0);
  });

  it("moves up and wraps past the first row", () => {
    expect(after(state(2), { name: "up" }, single).cursor).toBe(1);
    expect(after(state(0), { name: "up" }, single).cursor).toBe(3);
  });

  it("accepts j/k, ctrl-n/ctrl-p and tab as movement", () => {
    expect(after(state(0), { name: "j" }, single).cursor).toBe(1);
    expect(after(state(1), { name: "k" }, single).cursor).toBe(0);
    expect(after(state(0), { name: "n", ctrl: true }, single).cursor).toBe(1);
    expect(after(state(1), { name: "p", ctrl: true }, single).cursor).toBe(0);
    expect(after(state(0), { name: "tab" }, single).cursor).toBe(1);
    expect(after(state(0), { name: "tab", shift: true }, single).cursor).toBe(3);
  });

  it("jumps with home, end and the row's own number", () => {
    expect(after(state(2), { name: "home" }, single).cursor).toBe(0);
    expect(after(state(0), { name: "end" }, single).cursor).toBe(3);
    expect(after(state(0), { name: "3" }, single).cursor).toBe(2);
  });

  it("ignores a number past the end of the list, and unknown keys", () => {
    expect(applySelectKey(state(1), { name: "9" }, single).kind).toBe("ignore");
    expect(applySelectKey(state(1), { name: "escape" }, single).kind).toBe("ignore");
    expect(applySelectKey(state(1), { name: "c", ctrl: true }, single).kind).toBe("ignore");
    expect(applySelectKey(state(1), {}, single).kind).toBe("ignore");
  });
});

describe("applySelectKey selection", () => {
  it("submits the row under the cursor in single-select", () => {
    const outcome = applySelectKey(state(2), { name: "return" }, single);
    expect(outcome).toMatchObject({ kind: "submit" });
    expect(outcome.kind === "submit" && outcome.state.cursor).toBe(2);
  });

  it("ignores space and 'a' in single-select", () => {
    expect(applySelectKey(state(0), { name: "space" }, single).kind).toBe("ignore");
    expect(applySelectKey(state(0), { name: "a" }, single).kind).toBe("ignore");
  });

  it("toggles the row under the cursor with space", () => {
    const ticked = after(state(1), { name: "space" }, multi);
    expect([...ticked.selected]).toEqual([1]);
    expect([...after(ticked, { name: "space" }, multi).selected]).toEqual([]);
  });

  it("ticks every row with 'a', and clears them all when they are already ticked", () => {
    const all = after(state(0), { name: "a" }, multi);
    expect([...all.selected].toSorted()).toEqual([0, 1, 2, 3]);
    expect([...after(all, { name: "a" }, multi).selected]).toEqual([]);
  });

  it("refuses to submit a multi-select below its minimum, then accepts it", () => {
    const refused = applySelectKey(state(0), { name: "return" }, multi);
    expect(refused).toEqual({ kind: "refuse", message: "select at least one with space" });

    const ticked = after(state(0), { name: "space" }, multi);
    expect(applySelectKey(ticked, { name: "return" }, multi).kind).toBe("submit");
  });

  it("submits an empty multi-select when nothing is required", () => {
    const outcome: SelectOutcome = applySelectKey(
      state(0),
      { name: "return" },
      {
        ...multi,
        min: 0,
      },
    );
    expect(outcome.kind).toBe("submit");
  });
});

describe("selectWindow", () => {
  it("shows every row when the list fits", () => {
    expect(selectWindow(0, 4, 10)).toEqual({ start: 0, end: 4 });
  });

  it("keeps the cursor roughly centred and clamps at both ends", () => {
    expect(selectWindow(0, 30, 10)).toEqual({ start: 0, end: 10 });
    expect(selectWindow(15, 30, 10)).toEqual({ start: 10, end: 20 });
    expect(selectWindow(29, 30, 10)).toEqual({ start: 20, end: 30 });
  });
});

describe("renderSelect", () => {
  const choices = [
    { label: "opus", hint: "Most capable" },
    { label: "sonnet" },
    { label: "haiku" },
  ];

  it("points at the cursor row and leaves the others unmarked", () => {
    const block = renderSelect("Model", choices, state(1), {
      multi: false,
      width: 80,
      maxRows: 10,
    });
    const lines = block.trimEnd().split("\n");
    expect(lines[0]).toBe("Model");
    expect(lines[1]).toBe("    opus - Most capable");
    expect(lines[2]).toBe("  ❯ sonnet");
    expect(lines.at(-1)).toContain("enter confirm");
  });

  it("draws a checkbox per row in multi-select", () => {
    const block = renderSelect("Labels", choices, state(0, [2]), {
      multi: true,
      width: 80,
      maxRows: 10,
    });
    const lines = block.split("\n");
    expect(lines[1]).toBe("  ❯ ◯ opus - Most capable");
    expect(lines[3]).toBe("    ◉ haiku");
    expect(block).toContain("space select");
  });

  it("shows how many rows are hidden above and below the window", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ label: `label-${index}` }));
    const block = renderSelect("Labels", many, state(15), { multi: true, width: 80, maxRows: 10 });
    expect(block).toContain("⋯ 10 more above");
    expect(block).toContain("⋯ 10 more below");
    expect(paintedLines(block)).toBe(14); // question + 10 rows + 2 markers + footer
  });

  it("shows a refusal notice under the list", () => {
    const block = renderSelect("Labels", choices, state(0), {
      multi: true,
      width: 80,
      maxRows: 10,
      notice: "select at least one with space",
    });
    expect(block).toContain("  ! select at least one with space");
  });

  it("clips every row to the terminal width so the repaint stays in sync", () => {
    const wide = [{ label: "x".repeat(200) }];
    const block = renderSelect("Model", wide, state(0), { multi: false, width: 40, maxRows: 10 });
    for (const line of block.trimEnd().split("\n")) expect(line.length).toBeLessThan(40);
  });
});

describe("clip", () => {
  it("leaves a short line alone and marks a truncated one", () => {
    expect(clip("short", 40)).toBe("short");
    expect(clip("x".repeat(50), 20)).toBe(`${"x".repeat(18)}…`);
  });
});

describe("repaintPrefix", () => {
  it("only clears when nothing has been painted yet", () => {
    expect(repaintPrefix(0)).toBe(`${ESC}[0J`);
    expect(repaintPrefix(3)).toBe(`${ESC}[3A${ESC}[0J`);
  });
});

describe("parseIndexList", () => {
  it("accepts comma- or space-separated numbers, deduped and sorted", () => {
    expect(parseIndexList("3, 1 1", 4, 1)).toEqual({ indices: [0, 2] });
  });

  it("rejects anything outside the list", () => {
    expect(parseIndexList("5", 4, 1)).toEqual({
      problem: '"5" is not a number between 1 and 4',
    });
    expect(parseIndexList("two", 4, 1)).toEqual({
      problem: '"two" is not a number between 1 and 4',
    });
  });

  it("treats an empty answer or 'none' as no selection when none is allowed", () => {
    expect(parseIndexList("none", 4, 0)).toEqual({ indices: [] });
    expect(parseIndexList("  ", 4, 0)).toEqual({ indices: [] });
    expect(parseIndexList("", 4, 1)).toEqual({ problem: "enter at least 1 number(s)" });
  });
});
