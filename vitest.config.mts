import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    conditions: ["react-server"],
    alias: {
      "server-only": fileURLToPath(
        new URL("./tests/server-only-mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "trigger/**/*.test.ts"],
    environment: "node",
    watch: false,
  },
});
