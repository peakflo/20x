/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import type { SessionConfig } from './coding-agent-adapter'

const base: SessionConfig = { agentId: 'a', taskId: 't', workspaceDir: '/work', authMethod: 'subscription' }

describe('harness instance environment', () => {
  it('runs two Codex instances in parallel with distinct CODEX_HOME', async () => {
    const work = new CodexAppServerAdapter({ harnessHome: '/accounts/codex-work' })
    const personal = new CodexAppServerAdapter({ harnessHome: '/accounts/codex-personal' })

    // Both environments are built at the same time, as two live sessions would be.
    const [workEnv, personalEnv] = await Promise.all([
      Promise.resolve((work as any).buildEnvironment(base).env),
      Promise.resolve((personal as any).buildEnvironment(base).env),
    ])

    expect(workEnv.CODEX_HOME).toBe('/accounts/codex-work')
    expect(personalEnv.CODEX_HOME).toBe('/accounts/codex-personal')
  })

  it('lets a session config override the adapter home', () => {
    const adapter = new CodexAppServerAdapter({ harnessHome: '/accounts/codex-work' })
    const env = (adapter as any).buildEnvironment({ ...base, harnessHome: '/accounts/codex-other' }).env
    expect(env.CODEX_HOME).toBe('/accounts/codex-other')
  })

  it('uses the default Codex home when no instance home is set', () => {
    const adapter = new CodexAppServerAdapter()
    const env = (adapter as any).buildEnvironment(base).env
    expect(env.CODEX_HOME).toBeTruthy()
  })

  it('the default Claude Code instance sets no config directory, so its login and state are unchanged', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      const adapter = new ClaudeCodeAdapter()
      expect((adapter as any).buildClaudeEnvironment().CLAUDE_CONFIG_DIR).toBeUndefined()
      expect((adapter as any).buildClaudeEnvironment(undefined).CLAUDE_CONFIG_DIR).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  it('the default Claude Code instance keeps an inherited CLAUDE_CONFIG_DIR as it was', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/inherited/claude'
    try {
      expect((new ClaudeCodeAdapter() as any).buildClaudeEnvironment().CLAUDE_CONFIG_DIR).toBe('/inherited/claude')
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  it('runs two Claude Code instances in parallel with distinct CLAUDE_CONFIG_DIR', () => {
    const first = new ClaudeCodeAdapter({ harnessHome: '/accounts/claude-first' })
    const second = new ClaudeCodeAdapter({ harnessHome: '/accounts/claude-second' })

    expect((first as any).buildClaudeEnvironment().CLAUDE_CONFIG_DIR).toBe('/accounts/claude-first')
    expect((second as any).buildClaudeEnvironment().CLAUDE_CONFIG_DIR).toBe('/accounts/claude-second')
    expect((second as any).buildClaudeEnvironment('/accounts/claude-third').CLAUDE_CONFIG_DIR).toBe('/accounts/claude-third')
  })

  it('reads Claude session history from the instance config directory', async () => {
    const instanceHome = mkdtempSync(join(tmpdir(), 'claude-instance-'))
    try {
      // A transcript written by the instance's own Claude Code, under its projects directory.
      const dir = join(instanceHome, 'projects', '-work')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session-9.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello from work' }] } }) + '\n')

      const adapter = new ClaudeCodeAdapter({ harnessHome: instanceHome })
      const messages = await (adapter as any).loadSessionHistory('session-9', '/work')
      expect(messages).toHaveLength(1)

      // The same session is not visible to an adapter that uses another home.
      const other = new ClaudeCodeAdapter({ harnessHome: join(instanceHome, 'elsewhere') })
      await expect((other as any).loadSessionHistory('session-9', '/work')).rejects.toThrow('SESSION_FILE_NOT_FOUND')
    } finally {
      rmSync(instanceHome, { recursive: true, force: true })
    }
  })
})
