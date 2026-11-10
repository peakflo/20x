/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }))

import { ClaudeCodeAdapter } from './claude-code-adapter'

/**
 * Resume reads the Claude Code session JSONL once, asynchronously and in
 * chunks, cleans it in memory and only rewrites it when something was removed.
 * These tests pin the behaviour of the old synchronous read-clean-write-reread.
 */
const SESSION = '0b0e7f3c-1d2e-4f5a-8b9c-0123456789ab'
const WORKSPACE = '/work/session-file'

let home: string
let file: string
const config = () => ({ agentId: 'a', taskId: 't', workspaceDir: WORKSPACE, harnessHome: home }) as any

const user = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (uuid: string, content: unknown[]) => JSON.stringify({ type: 'assistant', uuid, timestamp: '2026-10-01T00:00:01.000Z', message: { id: `msg_${uuid}`, role: 'assistant', content } })
const snapshot = JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), '20x-session-file-'))
  const dir = join(home, 'projects', WORKSPACE.replace(/[^a-zA-Z0-9-]/g, '-'))
  mkdirSync(dir, { recursive: true })
  file = join(dir, `${SESSION}.jsonl`)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe('ClaudeCodeAdapter session file on resume', () => {
  it('removes messages with an empty text block from the file and the history', async () => {
    writeFileSync(file, [
      user('u1', 'hello'),
      assistant('a1', [{ type: 'text', text: '  ' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
      snapshot,
      assistant('a2', [{ type: 'text', text: 'done' }])
    ].join('\n') + '\n')

    const messages = await new ClaudeCodeAdapter().resumeSession(SESSION, config())

    expect(messages.map((m) => m.id)).toEqual(['u1', 'a2'])
    expect(readFileSync(file, 'utf-8')).toBe([user('u1', 'hello'), snapshot, assistant('a2', [{ type: 'text', text: 'done' }])].join('\n') + '\n')
  })

  it('leaves a file with nothing to clean untouched', async () => {
    const content = '\n' + [user('u1', 'hello'), assistant('a1', [{ type: 'text', text: 'hi' }])].join('\n') + '\n\n'
    writeFileSync(file, content)
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(file, old, old)

    const messages = await new ClaudeCodeAdapter().resumeSession(SESSION, config())

    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(readFileSync(file, 'utf-8')).toBe(content)
    expect(statSync(file).mtimeMs).toBe(old.getTime())
  })

  it('rebuilds the same history as a fresh read of the cleaned file', async () => {
    writeFileSync(file, [
      user('u1', 'run it'),
      assistant('a1', [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'running' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
      ]),
      JSON.stringify({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }] } }),
      assistant('a2', [{ type: 'text', text: '' }]),
      assistant('a3', [{ type: 'text', text: 'listed' }])
    ].join('\n') + '\n')

    const resumed = await new ClaudeCodeAdapter().resumeSession(SESSION, config())
    const reread = await new ClaudeCodeAdapter().getPersistedMessages(SESSION, config())

    expect(resumed).toEqual(reread)
    expect(resumed.map((m) => m.id)).toEqual(['u1', 'a1', 'a3'])
    const tool = resumed[1].parts.find((p) => p.tool)!.tool!
    expect(tool).toMatchObject({ name: 'Bash', status: 'success', output: 'a.txt' })
    expect(resumed[1].parts[0].receivedAt).toBe(Date.parse('2026-10-01T00:00:01.000Z'))
  })

  it('reads lines that span read chunks and multi-byte characters split across them', async () => {
    // Each line is ~300 KB of multi-byte text, so lines and characters cross
    // the 1 MB read boundaries at arbitrary points.
    const lines = Array.from({ length: 12 }, (_, i) =>
      assistant(`a${i}`, [{ type: 'text', text: `${i} ` + 'Привет, мир — 你好 🌍 '.repeat(12_000) }]))
    writeFileSync(file, lines.join('\n') + '\n')

    const messages = await new ClaudeCodeAdapter().resumeSession(SESSION, config())

    expect(messages).toHaveLength(12)
    messages.forEach((m, i) => expect(m.parts[0].text).toBe(JSON.parse(lines[i]).message.content[0].text))
  })

  it('accepts CRLF line endings and surrounding whitespace, as before', async () => {
    writeFileSync(file, '  \r\n' + user('u1', 'hello') + '\r\n' + assistant('a1', [{ type: 'text', text: 'hi' }]) + '\r\n \n')

    const messages = await new ClaudeCodeAdapter().resumeSession(SESSION, config())

    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('throws SESSION_FILE_NOT_FOUND when the file is missing', async () => {
    rmSync(file, { force: true })
    await expect(new ClaudeCodeAdapter().resumeSession(SESSION, config())).rejects.toThrow('SESSION_FILE_NOT_FOUND')
  })

  it('returns no history and leaves the file alone when a line is not JSON', async () => {
    const content = [user('u1', 'hello'), '{not json', assistant('a1', [{ type: 'text', text: '' }])].join('\n') + '\n'
    writeFileSync(file, content)

    await expect(new ClaudeCodeAdapter().resumeSession(SESSION, config())).resolves.toEqual([])
    expect(readFileSync(file, 'utf-8')).toBe(content)
  })

  it('treats a blank line in the middle as corrupt, as before', async () => {
    writeFileSync(file, [user('u1', 'hello'), '', assistant('a1', [{ type: 'text', text: 'hi' }])].join('\n') + '\n')
    await expect(new ClaudeCodeAdapter().resumeSession(SESSION, config())).resolves.toEqual([])
  })

  it('returns no history for an empty file', async () => {
    writeFileSync(file, '\n')
    await expect(new ClaudeCodeAdapter().resumeSession(SESSION, config())).resolves.toEqual([])
  })
})
