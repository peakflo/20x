import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5174,
    // Proxy API and WebSocket requests to the Electron mobile-api-server
    proxy: {
      '/api': {
        target: 'http://localhost:20620',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:20620',
        ws: true
      }
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true
  }
})
