import { defineConfig } from 'vitest/config'

// แยกจาก vite.config.ts (ไม่โหลด PWA plugin / __BUILD__) — test จำลองหลายเครื่องใน Node + jsdom
export default defineConfig({
  define: { __BUILD__: JSON.stringify('test'), __BUILD_AT__: JSON.stringify(1792500000000) },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
  },
})
