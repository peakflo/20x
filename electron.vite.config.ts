import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: [
        '@electron-toolkit/utils',
        '@paralleldrive/cuid2',
        '@modelcontextprotocol/sdk',
        // Bundle pure-JS deps to enable tree-shaking and avoid shipping them in node_modules
        'js-yaml',
        'cron-parser',
        '@opencode-ai/sdk',
        'electron-updater'
      ]
    })],
    resolve: {
      extensions: ['.js', '.ts', '.jsx', '.tsx', '.json']
    },
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'node-pty'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'mcp-servers/task-management-mcp': resolve(__dirname, 'src/main/mcp-servers/task-management-mcp.js')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
