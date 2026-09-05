import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  applySelectKey,
  HIDE_CURSOR,
  paintedLines,
  parseIndexList,
  renderSelect,
  repaintPrefix,
  SHOW_CURSOR,
  type SelectKey,
  type SelectState,
} from "./prompt-select.ts";

/**
 * Interactive prompts for `fixowl init`. Deliberately dependency-free: the CLI
 * ships as a single bundled file, so this is readline plus a writable stream we
 * can mute while a secret is typed or pasted.
 *
 * The arrow-key selector (`choose`, `multiChoose`) is hand-rolled for the same
 * reason - a TUI prompt library would be the one runtime dependency this CLI
 * has. It costs little: readline already puts the TTY in raw mode and decodes
 * keypresses for us, so this file only mutes readline's echo, paints the list
 * and hands each keypress to the pure reducer in `prompt-select.ts`. Without a
 * TTY (piped input, CI) both fall back to the numbered typed prompts.
 */

export interface AskOptions {
  default?: string;
  /** Returns a message explaining why the answer is unusable, or undefined when it is fine. */
  validate?: (answer: string) => string | undefined;
}

export interface SecretOptions {
  /** Current value; an empty answer keeps it. */
  existing?: string;
  validate?: (answer: string) => string | undefined;
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface MultiChooseOptions {
  /** Refuse to submit below this many selections. Defaults to 0 (any, including none). */
  min?: number;
}

export interface Prompter {
  ask(question: string, options?: AskOptions): Promise<string>;
  secret(question: string, options?: SecretOptions): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** One value, picked with the arrow keys (numbered typed input without a TTY). */
  choose<T>(question: string, choices: ReadonlyArray<Choice<T>>): Promise<T>;
  /** Any number of values, checkbox style; same fallback. */
  multiChoose<T>(
    question: string,
    choices: ReadonlyArray<Choice<T>>,
    options?: MultiChooseOptions,
  ): Promise<T[]>;
  /** Waits for Enter; the typed line is discarded. */
  pause(message: string): Promise<void>;
  say(message: string): void;
  close(): void;
}

/** A pass-through stream that drops writes while muted, hiding typed secrets. */
class MutableOutput extends Writable {
  muted = false;
  #target: NodeJS.WritableStream;

  constructor(target: NodeJS.WritableStream) {
    super();
    this.#target = target;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    if (!this.muted) this.#target.write(chunk);
    callback();
  }
}

/** Shows enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (value === "") return "(empty)";
  const head = value.slice(0, 4);
  return value.length > 12
    ? `${head}…${value.slice(-4)} (${value.length} chars)`
    : `${head}… (${value.length} chars)`;
}

/**
 * The line shown right after a masked prompt is submitted, confirming what
 * happened without ever revealing the raw secret. Empty string means "say
 * nothing" (the caller falls back to a bare newline), which only happens for
 * an empty answer with no existing value to keep - that case gets its own
 * "please paste a value" error instead of a false confirmation.
 */
export function secretConfirmation(raw: string, keeps: boolean): string {
  if (raw === "") return keeps ? "✓ kept existing\n" : "";
  return `✓ received ${maskSecret(raw)}\n`;
}

/** The recap left behind once a selector block is erased. */
export function selectionSummary(question: string, labels: readonly string[]): string {
  return `${question}: ${labels.length === 0 ? "(none)" : labels.join(", ")}\n`;
}

/** Rows a selector paints before it starts scrolling. */
const MAX_SELECT_ROWS = 10;

/** Arrow keys need a terminal on both ends: to read raw keys and to repaint. */
function keyboardDriven(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createPrompter(): Prompter {
  const output = new MutableOutput(process.stdout);
  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  rl.on("SIGINT", () => {
    output.muted = false;
    process.stdout.write(`${SHOW_CURSOR}\naborted; nothing was changed after the last step\n`);
    process.exit(130);
  });

  const write = (text: string): void => {
    output.write(text);
  };

  async function ask(question: string, options: AskOptions = {}): Promise<string> {
    const suffix = options.default !== undefined ? ` [${options.default}]` : "";
    for (;;) {
      const raw = (await rl.question(`${question}${suffix}: `)).trim();
      const answer = raw === "" ? (options.default ?? "") : raw;
      const problem = answer === "" ? "please enter a value" : options.validate?.(answer);
      if (problem === undefined) return answer;
      write(`  ! ${problem}\n`);
    }
  }

  async function secret(question: string, options: SecretOptions = {}): Promise<string> {
    const keeps = options.existing !== undefined && options.existing !== "";
    const suffix = keeps ? ` [keep ${maskSecret(options.existing ?? "")}]` : "";
    for (;;) {
      // The prompt is written before muting so the label stays visible; the
      // answer itself is never echoed (paste still works).
      write(`${question}${suffix}: `);
      output.muted = true;
      const raw = (await rl.question("")).trim();
      output.muted = false;
      write(secretConfirmation(raw, keeps) || "\n");
      if (raw === "" && keeps) return options.existing ?? "";
      const problem = raw === "" ? "please paste a value" : options.validate?.(raw);
      if (problem === undefined) return raw;
      write(`  ! ${problem}\n`);
    }
  }

  async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
    for (;;) {
      const raw = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `))
        .trim()
        .toLowerCase();
      if (raw === "") return defaultYes;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      write("  ! answer y or n\n");
    }
  }

  /**
   * Paints the list and drives it from readline's decoded keypresses. Readline
   * itself keeps reading in the background - its echo lands in the muted stream
   * and its line buffer is emptied by the Enter that confirms the selection -
   * so this never has to detach or re-attach the interface.
   */
  async function runSelector<T>(
    question: string,
    choices: ReadonlyArray<Choice<T>>,
    multi: boolean,
    min: number,
  ): Promise<number[]> {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const views = choices.map((choice) => ({ label: choice.label, hint: choice.hint }));
    emitKeypressEvents(stdin);
    rl.resume(); // nothing may have read a line yet, so make sure input flows

    return await new Promise<number[]>((resolve) => {
      let state: SelectState = { cursor: 0, selected: new Set<number>() };
      let notice: string | undefined;
      let painted = 0;

      const paint = (): void => {
        const block = renderSelect(question, views, state, {
          multi,
          width: stdout.columns ?? 80,
          maxRows: MAX_SELECT_ROWS,
          notice,
        });
        stdout.write(`${repaintPrefix(painted)}${block}`);
        painted = paintedLines(block);
      };

      const onKey = (_sequence: string | undefined, key: SelectKey | undefined): void => {
        const outcome = applySelectKey(state, key ?? {}, { count: choices.length, multi, min });
        switch (outcome.kind) {
          case "ignore":
            return;
          case "update":
            state = outcome.state;
            notice = undefined;
            break;
          case "refuse":
            notice = outcome.message;
            break;
          case "submit": {
            const indices = multi
              ? [...outcome.state.selected].toSorted((a, b) => a - b)
              : [outcome.state.cursor];
            stdin.off("keypress", onKey);
            // Replace the live block with a one-line recap of the answer.
            stdout.write(`${repaintPrefix(painted)}${SHOW_CURSOR}`);
            output.muted = false;
            stdout.write(selectionSummary(question, labelsOf(choices, indices)));
            resolve(indices);
            return;
          }
        }
        paint();
      };

      output.muted = true; // readline echoes the navigation keys; swallow that
      stdout.write(HIDE_CURSOR);
      stdin.on("keypress", onKey);
      paint();
    });
  }

  /** The no-TTY path for `choose`: the numbered prompt this CLI has always had. */
  async function chooseTyped<T>(
    question: string,
    choices: ReadonlyArray<Choice<T>>,
  ): Promise<number> {
    write(`${question}\n`);
    for (const [index, choice] of choices.entries()) {
      write(
        `  ${index + 1}) ${choice.label}${choice.hint !== undefined ? ` - ${choice.hint}` : ""}\n`,
      );
    }
    if (choices.length === 1) {
      await ask("Choice", {
        default: "1",
        validate: (a) => (a === "1" ? undefined : "only 1 is available"),
      });
      return 0;
    }
    const answer = await ask("Choice", {
      default: "1",
      validate: (a) => {
        const index = Number(a);
        return Number.isInteger(index) && index >= 1 && index <= choices.length
          ? undefined
          : `enter a number between 1 and ${choices.length}`;
      },
    });
    return Number(answer) - 1;
  }

  /** The no-TTY path for `multiChoose`: comma- or space-separated numbers. */
  async function multiChooseTyped<T>(
    question: string,
    choices: ReadonlyArray<Choice<T>>,
    min: number,
  ): Promise<number[]> {
    write(`${question}\n`);
    for (const [index, choice] of choices.entries()) {
      write(
        `  ${index + 1}) ${choice.label}${choice.hint !== undefined ? ` - ${choice.hint}` : ""}\n`,
      );
    }
    const answer = await ask(`Choices (numbers, comma-separated${min === 0 ? "; or none" : ""})`, {
      default: min === 0 ? "none" : undefined,
      validate: (value) => {
        const parsed = parseIndexList(value, choices.length, min);
        return "problem" in parsed ? parsed.problem : undefined;
      },
    });
    const parsed = parseIndexList(answer, choices.length, min);
    return "problem" in parsed ? [] : parsed.indices;
  }

  async function choose<T>(question: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    if (choices.length === 0) throw new Error("choose() needs at least one choice");
    const index = keyboardDriven()
      ? (await runSelector(question, choices, false, 1))[0]
      : await chooseTyped(question, choices);
    const picked = index === undefined ? undefined : choices[index];
    if (picked === undefined) throw new Error("unreachable: choice out of range");
    return picked.value;
  }

  async function multiChoose<T>(
    question: string,
    choices: ReadonlyArray<Choice<T>>,
    options: MultiChooseOptions = {},
  ): Promise<T[]> {
    if (choices.length === 0) return [];
    const min = Math.min(options.min ?? 0, choices.length);
    const indices = keyboardDriven()
      ? await runSelector(question, choices, true, min)
      : await multiChooseTyped(question, choices, min);
    return valuesOf(choices, indices);
  }

  return {
    ask,
    secret,
    confirm,
    choose,
    multiChoose,
    async pause(message: string): Promise<void> {
      await rl.question(message);
    },
    say: write,
    close(): void {
      output.muted = false;
      rl.close();
    },
  };
}

function labelsOf<T>(choices: ReadonlyArray<Choice<T>>, indices: readonly number[]): string[] {
  return indices.flatMap((index) => {
    const choice = choices[index];
    return choice === undefined ? [] : [choice.label];
  });
}

function valuesOf<T>(choices: ReadonlyArray<Choice<T>>, indices: readonly number[]): T[] {
  return indices.flatMap((index) => {
    const choice = choices[index];
    return choice === undefined ? [] : [choice.value];
  });
}
