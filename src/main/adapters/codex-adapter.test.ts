import { describe, it, expect } from 'vitest'
import { DEFAULT_CODEX_MODEL } from './codex-adapter'

describe('DEFAULT_CODEX_MODEL', () => {
  it('defaults Codex sessions to GPT-5.4 Codex', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.4-codex')
  })
})

describe('CodexAdapter findCodexExecutable fallback paths', () => {
  it('should include pnpm and volta paths in source for macOS fallback', () => {
    const fs = require('fs')
    const path = require('path')
    const source = fs.readFileSync(
      path.join(__dirname, 'codex-adapter.ts'),
      'utf8'
    )

    // Verify new fallback paths are present
    expect(source).toContain('Library/pnpm/codex')
    expect(source).toContain('.volta/bin/codex')
  })

  it('should dynamically detect NVM paths instead of hardcoding', () => {
    const fs = require('fs')
    const path = require('path')
    const source = fs.readFileSync(
      path.join(__dirname, 'codex-adapter.ts'),
      'utf8'
    )

    // Should have NVM dynamic detection logic
    expect(source).toContain("'.nvm', 'versions', 'node'")
    expect(source).toContain('readdirSync')
    // Should NOT have hardcoded version numbers
    expect(source).not.toMatch(/\.nvm\/versions\/node\/v\d+\.\d+\.\d+/)
  })
})
