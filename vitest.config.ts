import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Database-backed suites start mongodb-memory-server; the first run downloads the
    // pinned binary (package.json config.mongodbMemoryServer.version) from fastdl.mongodb.org.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
