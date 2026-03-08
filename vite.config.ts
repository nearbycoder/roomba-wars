import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/three')) {
            return 'three-core'
          }
          if (id.includes('@react-three')) {
            return 'three-react'
          }
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['server/**/*.test.ts'],
  },
})
