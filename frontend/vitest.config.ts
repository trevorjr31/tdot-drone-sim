import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so tests don't run the Cesium asset-copy plugin.
// Tests cover plain logic (search, geometry, grid, settings), so Node is enough.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
