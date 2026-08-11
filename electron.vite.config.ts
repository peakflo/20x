import { copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function defineEnv(name: string): string {
  return JSON.stringify(process.env[name] ?? '')
}

/**
 * Copies the voice workers next to the main bundle instead of bundling them.
 * Each worker is a plain CommonJS script that requires the local speech runtime
 * by name at run time, so it must stay unbundled and must exist as a real file
 * for `child_process.fork`.
 *
 * One worker recognises speech, the other produces it.
 */
const VOICE_WORKER_FILES = ['voice-worker.js', 'voice-tts-worker.js']

function copyVoiceWorker(): PluginOption {
  return {
    name: 'copy-voice-worker',
    closeBundle() {
      const outDir = resolve(__dirname, 'out/main/voice')
      mkdirSync(outDir, { recursive: true })
      for (const file of VOICE_WORKER_FILES) {
        copyFileSync(resolve(__dirname, 'src/main/voice', file), resolve(outDir, file))
      }
    }
  }
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
    }), copyVoiceWorker()],
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
