import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('fixPlatformPath behaviour', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  describe('shell invocation uses markers for safe PATH extraction', () => {
    it('should use -ilc with marker-based PATH extraction (shell-env.ts)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(path.join(__dirname, 'shell-env.ts'), 'utf8')
      const { buildShellEnvCommand } = await import('./shell-env')

      // Uses interactive login shell to pick up .zshrc paths (NVM, pnpm, etc.)
      expect(source).toContain("'-ilc'")
      // Uses markers to extract PATH from noisy interactive shell output
      expect(buildShellEnvCommand()).toContain('__20X_PATH_START__')
      expect(buildShellEnvCommand()).toContain('__20X_PATH_END__')
    })

    it('fix-path-manual.ts should also use markers', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.join(__dirname, 'fix-path-manual.ts'),
        'utf8'
      )

      expect(source).toContain('__20X_PATH_START__')
      expect(source).toContain('__20X_PATH_END__')
    })
  })

  describe('fallback PATH construction', () => {
    it('should include essential macOS paths in fallback', async () => {
      const { buildFallbackPath } = await import('./shell-env')
      const home = '/Users/test'
      const result = buildFallbackPath({ home, existingPath: '', nvmDir: '/nonexistent', exists: () => true }).split(':')

      const requiredFallbackPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        `${home}/.local/bin`,
        `${home}/.npm-global/bin`,
        `${home}/Library/pnpm`,
        `${home}/.volta/bin`,
      ]

      for (const p of requiredFallbackPaths) {
        expect(result).toContain(p)
      }
    })

    it('should NOT hardcode a specific NVM Node version', async () => {
      const fs = await import('fs')
      const path = await import('path')
      for (const file of ['index.ts', 'shell-env.ts']) {
        const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
        expect(source).not.toMatch(/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin/)
      }
    })
  })
})
