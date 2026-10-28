#!/usr/bin/env node
import { buildProgram } from "./cli.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    process.stderr.write(`hedgehood: ${e instanceof Error ? e.message.split("\n").slice(0, 4).join(" | ") : String(e)}\n`);
    process.exit(1);
  });
