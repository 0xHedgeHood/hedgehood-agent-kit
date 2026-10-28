import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@hedgehood-io/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
      "@hedgehood-io/mcp": fileURLToPath(new URL("../mcp/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
