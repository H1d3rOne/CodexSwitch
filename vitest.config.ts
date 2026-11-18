import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    // The popup suite renders the whole App repeatedly; parallel files can starve a single test.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
