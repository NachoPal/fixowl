import { log } from "./log.ts";
import { createProgram } from "./program.ts";

createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
