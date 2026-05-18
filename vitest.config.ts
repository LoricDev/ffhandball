import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env");
} catch {
  // .env optional (CI may set env vars directly)
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    passWithNoTests: true,
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
