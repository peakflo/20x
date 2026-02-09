import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dir, 'src/shared'),
      '@': resolve(__dir, 'src/renderer/src')
    }
  },
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
          setupFiles: ['./test/setup-main.ts']
        },
        resolve: {
          alias: {
            '@shared': resolve(__dir, 'src/shared')
          }
        }
      },
      {
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/src/**/*.test.ts', 'src/renderer/src/**/*.test.tsx'],
          setupFiles: ['./test/setup-renderer.ts']
        },
        resolve: {
          alias: {
            '@shared': resolve(__dir, 'src/shared'),
            '@': resolve(__dir, 'src/renderer/src')
          }
        }
      }
    ]
  }
})
