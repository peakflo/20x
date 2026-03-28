/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We test the buildFallbackPath() logic and the shell invocation flags
// indirectly by extracting the relevant code into testable units.

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

  describe('shell invocation flags', () => {
    it('should use -lc (login, non-interactive) and NOT -ilc', async () => {
      // Read the source file and verify the shell flags
      const fs = await import('fs')
      const path = await import('path')
      const indexSource = fs.readFileSync(
        path.join(__dirname, 'index.ts'),
        'utf8'
      )

      // Verify `-lc` is used (login, non-interactive)
      expect(indexSource).toContain("'-lc'")
      // Verify `-ilc` is NOT used (interactive mode causes issues in GUI apps)
      expect(indexSource).not.toContain("'-ilc'")
    })

    it('fix-path-manual.ts should also use -lc and NOT -ilc', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.join(__dirname, 'fix-path-manual.ts'),
        'utf8'
      )

      expect(source).toContain('-lc')
      expect(source).not.toContain('-ilc')
    })
  })

  describe('fallback PATH construction', () => {
    it('should include essential macOS paths in fallback', () => {
      // Read the source and verify all critical fallback paths are present
      const fs = require('fs')
      const path = require('path')
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

    it('should NOT hardcode a specific NVM Node version', () => {
      const fs = require('fs')
      const path = require('path')
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
