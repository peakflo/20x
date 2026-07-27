import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function defineEnv(name: string): string {
  return JSON.stringify(process.env[name] ?? '')
}

export default defineConfig({
  main: {
    define: {
      __POSTHOG_KEY__: defineEnv('POSTHOG_KEY'),
      __POSTHOG_HOST__: defineEnv('POSTHOG_HOST'),
      __TELEMETRY_ENABLED__: defineEnv('TELEMETRY_ENABLED'),
      __TELEMETRY_FLUSH_BATCH_SIZE__: defineEnv('TELEMETRY_FLUSH_BATCH_SIZE'),
      __TELEMETRY_MAX_BUFFERED_EVENTS__: defineEnv('TELEMETRY_MAX_BUFFERED_EVENTS')
    },
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
