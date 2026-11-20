import { defineConfig } from "vitest/config";

/**
 * Each package runs vitest in its own directory. The config file is at the
 * repo root, so the project root is the caller's directory and the include
 * pattern is that package's test files.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    root: process.cwd(),
  },
});
