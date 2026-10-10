import { describe, expect, it } from 'vitest'
import { detectInstaller } from './installer-detect'

describe('detectInstaller — native installs', () => {
  it('recognizes Claude Code under ~/.local/bin', () => {
    const result = detectInstaller('claude-code', '/Users/dev/.local/bin/claude', '@anthropic-ai/claude-code')
    expect(result.installer).toBe('native')
    expect(result.updateArgv).toEqual({ cmd: '/Users/dev/.local/bin/claude', args: ['update'] })
    expect(result.lockKey).toBe('native:claude-code')
  })

  it('recognizes Claude Code under ~/.local/share/claude', () => {
    const result = detectInstaller('claude-code', '/Users/dev/.local/share/claude/bin/claude', '@anthropic-ai/claude-code')
    expect(result.installer).toBe('native')
  })

  it('recognizes a standalone Codex install', () => {
    const result = detectInstaller('codex', '/Users/dev/.local/bin/codex', '@openai/codex')
    expect(result.installer).toBe('native')
    expect(result.updateCommand).toBe('codex update')
  })

  it('recognizes OpenCode under ~/.opencode/bin', () => {
    const result = detectInstaller('opencode', '/Users/dev/.opencode/bin/opencode', 'opencode-ai')
    expect(result.installer).toBe('native')
    expect(result.updateCommand).toBe('opencode upgrade')
  })

  it('matches native installs on Windows paths too', () => {
    const result = detectInstaller('claude-code', 'C:\\Users\\dev\\.local\\bin\\claude.exe', '@anthropic-ai/claude-code')
    expect(result.installer).toBe('native')
  })
})

describe('detectInstaller — npm global', () => {
  it('detects a macOS/Linux npm global prefix', () => {
    const result = detectInstaller('codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', '@openai/codex')
    expect(result.installer).toBe('npm-global')
    expect(result.updateCommand).toBe('npm install -g --prefix /usr/local @openai/codex@latest')
    expect(result.lockKey).toBe('npm-global:/usr/local')
  })

  it('detects an nvm-managed npm global prefix (still npm-owned)', () => {
    const home = '/Users/dev/.nvm/versions/node/v22.1.0'
    const result = detectInstaller('codex', `${home}/lib/node_modules/@openai/codex/bin/codex.js`, '@openai/codex')
    expect(result.installer).toBe('npm-global')
    expect(result.lockKey).toBe(`npm-global:${home.toLowerCase()}`)
  })

  it('rejects a nested/transitive node_modules package', () => {
    const result = detectInstaller(
      'codex',
      '/usr/local/lib/node_modules/some-wrapper/node_modules/@openai/codex/bin/codex.js',
      '@openai/codex'
    )
    expect(result.installer).toBe('manual')
  })

  it('returns manual when there is no npm package name to match against', () => {
    const result = detectInstaller('cursor', '/usr/local/lib/node_modules/cursor-agent/bin/cursor-agent', null)
    expect(result.installer).toBe('manual')
  })
})

describe('detectInstaller — pnpm/yarn/bun global', () => {
  it('detects a pnpm global install (macOS XDG-ish path)', () => {
    const result = detectInstaller('opencode', '/Users/dev/Library/pnpm/global/5/node_modules/.bin/opencode', 'opencode-ai')
    expect(result.installer).toBe('pnpm-global')
    expect(result.updateCommand).toBe('pnpm add -g opencode-ai@latest')
  })

  it('detects a pnpm global install on Linux', () => {
    const result = detectInstaller('opencode', '/home/dev/.local/share/pnpm/global/5/node_modules/.bin/opencode', 'opencode-ai')
    expect(result.installer).toBe('pnpm-global')
  })

  it('detects a pnpm global install on Windows', () => {
    const result = detectInstaller('opencode', 'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.bin\\opencode.exe', 'opencode-ai')
    expect(result.installer).toBe('pnpm-global')
  })

  it('detects a yarn global install (POSIX)', () => {
    const result = detectInstaller('pi', '/Users/dev/.config/yarn/global/node_modules/.bin/pi', '@earendil-works/pi-coding-agent')
    expect(result.installer).toBe('yarn-global')
    expect(result.updateCommand).toBe('yarn global add @earendil-works/pi-coding-agent@latest')
  })

  it('detects a yarn global install (Windows "Data" form)', () => {
    const result = detectInstaller('pi', 'C:\\Users\\dev\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\.bin\\pi.cmd', '@earendil-works/pi-coding-agent')
    expect(result.installer).toBe('yarn-global')
  })

  it('detects a bun global install', () => {
    const result = detectInstaller('pi', '/Users/dev/.bun/bin/pi', '@earendil-works/pi-coding-agent')
    expect(result.installer).toBe('bun-global')
    expect(result.updateCommand).toBe('bun install -g @earendil-works/pi-coding-agent@latest')
  })
})

describe('detectInstaller — Homebrew', () => {
  it('detects a Homebrew formula (Cellar)', () => {
    const result = detectInstaller('opencode', '/opt/homebrew/Cellar/opencode/1.2.3/bin/opencode', 'opencode-ai')
    expect(result.installer).toBe('homebrew-formula')
    expect(result.updateCommand).toBe('brew upgrade opencode')
    expect(result.lockKey).toBe('homebrew')
  })

  it('detects a Homebrew cask (Caskroom)', () => {
    const result = detectInstaller('cursor', '/usr/local/Caskroom/cursor/1.2.3/Cursor.app/Contents/MacOS/cursor-agent', null)
    expect(result.installer).toBe('homebrew-cask')
    expect(result.updateCommand).toBe('brew upgrade --cask cursor')
  })

  it('rejects a Homebrew-keg-shaped path that is actually mise', () => {
    const result = detectInstaller('opencode', '/opt/homebrew/Cellar/mise/1.0.0/libexec/bin/opencode', 'opencode-ai')
    expect(result.installer).toBe('manual')
  })
})

describe('detectInstaller — version managers (manual-only)', () => {
  it('treats mise-managed installs as manual', () => {
    expect(detectInstaller('codex', '/Users/dev/.local/share/mise/installs/node/22/bin/codex', '@openai/codex').installer).toBe('manual')
    expect(detectInstaller('codex', '/Users/dev/.local/share/mise/shims/codex', '@openai/codex').installer).toBe('manual')
  })

  it('treats asdf-managed installs as manual', () => {
    expect(detectInstaller('codex', '/Users/dev/.asdf/installs/nodejs/22.1.0/bin/codex', '@openai/codex').installer).toBe('manual')
    expect(detectInstaller('codex', '/Users/dev/.asdf/shims/codex', '@openai/codex').installer).toBe('manual')
  })

  it('treats volta-managed installs as manual', () => {
    expect(detectInstaller('codex', '/Users/dev/.volta/bin/codex', '@openai/codex').installer).toBe('manual')
  })

  it('treats nvm-managed Node itself as manual (not an npm global package)', () => {
    expect(detectInstaller('codex', '/Users/dev/.nvm/versions/node/v22.1.0/bin/node', null).installer).toBe('manual')
  })
})

describe('detectInstaller — unknown', () => {
  it('falls back to manual for an unrecognized path', () => {
    const result = detectInstaller('codex', '/some/random/place/codex', '@openai/codex')
    expect(result.installer).toBe('manual')
    expect(result.updateArgv).toBeNull()
  })
})
