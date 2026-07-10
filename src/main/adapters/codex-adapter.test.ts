import { describe, it, expect } from 'vitest'
import { CodexAdapter, DEFAULT_CODEX_MODEL } from './codex-adapter'

type CodexAdapterWithArgs = {
  buildCodexArgs(config: { model?: string; reasoningEffort?: string }): string[]
}

describe('DEFAULT_CODEX_MODEL', () => {
  it('defaults Codex sessions to GPT-5.6 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol')
  })
})

describe('CodexAdapter findCodexExecutable fallback paths', () => {
  it('should include pnpm and volta paths in source for macOS fallback', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.join(__dirname, 'codex-adapter.ts'),
      'utf8'
    )

    // Verify new fallback paths are present
    expect(source).toContain('Library/pnpm/codex')
    expect(source).toContain('.volta/bin/codex')
  })

  it('should dynamically detect NVM paths instead of hardcoding', async () => {
    const fs = await import('fs')
    const path = await import('path')
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

  it('passes reasoning effort through Codex config overrides', () => {
    const adapter = new CodexAdapter()
    const buildCodexArgs = (adapter as unknown as CodexAdapterWithArgs).buildCodexArgs.bind(adapter)

    expect(buildCodexArgs({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })).toEqual([
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="high"',
      '--json-rpc',
    ])
  })

  it('does not pass unsupported max effort to Codex', () => {
    const adapter = new CodexAdapter()
    const buildCodexArgs = (adapter as unknown as CodexAdapterWithArgs).buildCodexArgs.bind(adapter)

    expect(buildCodexArgs({ model: 'gpt-5.6-sol', reasoningEffort: 'max' })).toEqual([
      '--model',
      'gpt-5.6-sol',
      '--json-rpc',
    ])
  })
})
