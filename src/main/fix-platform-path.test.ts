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
    it('should use -ilc with marker-based PATH extraction in index.ts', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const indexSource = fs.readFileSync(
        path.join(__dirname, 'index.ts'),
        'utf8'
      )

      // Uses interactive login shell to pick up .zshrc paths (NVM, pnpm, etc.)
      expect(indexSource).toContain("'-ilc'")
      // Uses markers to extract PATH from noisy interactive shell output
      expect(indexSource).toContain('__20X_PATH_START__')
      expect(indexSource).toContain('__20X_PATH_END__')
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
      const fs = await import('fs')
      const path = await import('path')
      const indexSource = fs.readFileSync(
        path.join(__dirname, 'index.ts'),
        'utf8'
      )

      const requiredFallbackPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '.local/bin',
        '.npm-global/bin',
        'Library/pnpm',
        '.volta/bin',
      ]

      for (const p of requiredFallbackPaths) {
        expect(indexSource).toContain(p)
      }
    })

    it('should NOT hardcode a specific NVM Node version', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const indexSource = fs.readFileSync(
        path.join(__dirname, 'index.ts'),
        'utf8'
      )

      // The old code had a hardcoded path like .nvm/versions/node/v22.14.0/bin
      // The new code should dynamically detect NVM versions
      expect(indexSource).not.toMatch(/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin/)
    })
  })
})
