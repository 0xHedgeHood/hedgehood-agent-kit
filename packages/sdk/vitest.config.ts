import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  // the shared fakes in ../mcp/test import the package by name; point it at the sources, not a stale dist
  resolve: { alias: { "@hedgehood-io/sdk": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
