import { defineConfig } from 'vitest/config'

/** 离线运行包内单元与交付测试；单个测试的超时单位为毫秒。 */
export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
