import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(async () => {
  const { default: tailwindcss } = await import('@tailwindcss/vite')

  return {
    root: resolve(__dirname, 'src/mobile'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    server: {
      port: 5174
    },
    build: {
      outDir: resolve(__dirname, 'out/mobile'),
      emptyOutDir: true
    }
  }
})
