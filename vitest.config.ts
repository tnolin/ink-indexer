import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // DB tests share one database and reset the `indexer` schema per file.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
