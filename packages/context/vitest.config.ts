import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ['tests/runtime/*.test.ts'],
    testTimeout: 30_000,
  },
})
