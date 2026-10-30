import { defineConfig } from "vitest/config";

// Root vitest runs only this package's suite. acp-adapter/ is a separate
// package that runs its own `node --test` suite (see acp-adapter/package.json);
// its files use node:test, so collecting them here fails with "no test suite
// found" and would also need its own dependencies installed.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
