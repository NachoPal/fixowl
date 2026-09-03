import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/**
 * Interactive prompts for `fixowl init`. Deliberately dependency-free: the CLI
 * ships as a single bundled file, so this is readline plus a writable stream we
 * can mute while a secret is typed or pasted.
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

export interface Prompter {
  ask(question: string, options?: AskOptions): Promise<string>;
  secret(question: string, options?: SecretOptions): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  choose<T>(question: string, choices: ReadonlyArray<Choice<T>>): Promise<T>;
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

export function createPrompter(): Prompter {
  const output = new MutableOutput(process.stdout);
  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  rl.on("SIGINT", () => {
    output.muted = false;
    process.stdout.write("\naborted; nothing was changed after the last step\n");
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
      write("\n");
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

  async function choose<T>(question: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    const first = choices[0];
    if (first === undefined) throw new Error("choose() needs at least one choice");
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
      return first.value;
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
    const picked = choices[Number(answer) - 1];
    if (picked === undefined) throw new Error("unreachable: choice out of range");
    return picked.value;
  }

  return {
    ask,
    secret,
    confirm,
    choose,
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
