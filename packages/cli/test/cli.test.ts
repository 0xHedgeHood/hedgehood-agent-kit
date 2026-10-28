import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("hedgehood cli", () => {
  it("registers the documented commands", () => {
    const p = buildProgram();
    const names = p.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["decode", "deposit", "fill", "instruments", "join", "markets", "positions", "quote", "redeem", "register", "session", "withdraw"]);
    const session = p.commands.find((c) => c.name() === "session")!;
    expect(session.commands.map((c) => c.name()).sort()).toEqual(["authorize", "revoke", "status"]);
  });

  it("every sending command is dry run unless --send", () => {
    const p = buildProgram();
    for (const name of ["join", "fill", "deposit", "redeem", "withdraw", "register"]) {
      const c = p.commands.find((x) => x.name() === name)!;
      expect(c.options.some((o) => o.long === "--send"), name).toBe(true);
    }
  });

  it("decode prints the instrument", async () => {
    const p = buildProgram();
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      captured += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      await p.parseAsync(["node", "hedgehood", "decode", "142087026062721526102620822511099174400"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("2026-10-30 220 C");
    expect(captured).toContain("expiry 1793390400");
  });
});
