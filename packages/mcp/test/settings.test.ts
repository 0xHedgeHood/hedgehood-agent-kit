import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createContext, loadConfig, readSettings, settingsPath, withSettings, x402Payer } from "../src/index.js";

const KEY = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;

describe("settings file (~/.hedgehood/config.json)", () => {
  it("path: HEDGEHOOD_CONFIG, else HEDGEHOOD_HOME/config.json, else ~/.hedgehood/config.json; off disables", () => {
    expect(settingsPath({})).toBe(resolve(homedir(), ".hedgehood", "config.json"));
    expect(settingsPath({ HEDGEHOOD_HOME: "/x/hh" })).toBe("/x/hh/config.json");
    expect(settingsPath({ HEDGEHOOD_CONFIG: "~/c.json" })).toBe(resolve(homedir(), "c.json"));
    expect(settingsPath({ HEDGEHOOD_CONFIG: "off" })).toBeUndefined();
  });

  it("reads {} when missing and refuses a file that is not a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-settings-"));
    expect(readSettings(join(dir, "none.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => readSettings(join(dir, "bad.json"))).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "arr.json"), "[]");
    expect(() => readSettings(join(dir, "arr.json"))).toThrow(/not a JSON object/);
  });

  it("fills only what the environment leaves unset; a raw key in the environment beats the file's key path", () => {
    const s = { chainId: 4663, account: "0x00000000000000000000000000000000000000aa" as const, sessionKeyFile: "/k/session.key", payerKeyFile: "/k/payer.key", siteUrl: "https://s.test" };
    expect(withSettings({}, s)).toEqual({ HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_ACCOUNT: s.account, HEDGEHOOD_SESSION_KEY_FILE: "/k/session.key", HEDGEHOOD_PAYER_KEY_FILE: "/k/payer.key", HEDGEHOOD_SITE_URL: "https://s.test" });
    const env = withSettings({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: KEY("11"), HEDGEHOOD_ACCOUNT: "${HEDGEHOOD_ACCOUNT}" }, s);
    expect(env.HEDGEHOOD_CHAIN_ID).toBe("46630");
    expect(env.HEDGEHOOD_SESSION_KEY_FILE).toBeUndefined();
    expect(env.HEDGEHOOD_ACCOUNT).toBe(s.account); // an unexpanded plugin placeholder counts as unset
  });

  it("the payment wallet pays x402 deposits before the owner and the session key", () => {
    const base = { HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_ACCOUNT: "0x00000000000000000000000000000000000000aa" };
    const all = createContext(loadConfig({ ...base, HEDGEHOOD_SESSION_KEY: KEY("11"), HEDGEHOOD_OWNER_KEY: KEY("22"), HEDGEHOOD_PAYER_KEY: KEY("33") }));
    expect(x402Payer(all)?.address).toBe(privateKeyToAccount(KEY("33")).address);
    const noPayer = createContext(loadConfig({ ...base, HEDGEHOOD_SESSION_KEY: KEY("11"), HEDGEHOOD_OWNER_KEY: KEY("22") }));
    expect(x402Payer(noPayer)?.address).toBe(privateKeyToAccount(KEY("22")).address);
    const sessionOnly = createContext(loadConfig({ ...base, HEDGEHOOD_SESSION_KEY: KEY("11") }));
    expect(x402Payer(sessionOnly)?.address).toBe(privateKeyToAccount(KEY("11")).address);
  });
});
