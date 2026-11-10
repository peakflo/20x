/**
 * Main-process cost of resuming a Claude Code session from its JSONL file.
 *
 * `resumeSession` cleans the session file (drops messages with empty text
 * blocks, which the API rejects) and then rebuilds the history from it. Long
 * sessions reach tens of MB.
 *
 * Fixture: a realistic JSONL session (user prompts, assistant text, thinking,
 * tool_use + tool_result pairs with outputs from 200 B to 8 KB, file-history
 * snapshots) of ~1 / 10 / 50 MB, with no empty text block — the common case,
 * where cleaning has nothing to remove.
 *
 * Printed per size (median of 5 resumes):
 * - wall ms for `resumeSession`
 * - longest main-thread block (ms): the largest gap seen by a 1 ms timer probe
 * - MB read from / written to the session file through `fs`
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { median, printResults } from '../../../test/helpers/perf-helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }))

/** Bytes moved through `fs` for the session file, by any API the adapter may use. */
const io = { read: 0, written: 0 }
const isSession = (p: unknown): boolean => String(p).endsWith('.jsonl')
const size = (data: unknown): number =>
  typeof data === 'string' ? Buffer.byteLength(data) : (data as { length?: number })?.length ?? 0

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  const readFileSync = ((p: never, ...rest: never[]) => {
    const out = (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    if (isSession(p)) io.read += size(out)
    return out
  }) as typeof fs.readFileSync
  const writeFileSync = ((p: never, data: never, ...rest: never[]) => {
    if (isSession(p)) io.written += size(data)
    return (fs.writeFileSync as (...a: unknown[]) => unknown)(p, data, ...rest)
  }) as typeof fs.writeFileSync
  const promises = {
    ...fs.promises,
    readFile: async (p: never, ...rest: never[]) => {
      const out = await (fs.promises.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
      if (isSession(p)) io.read += size(out)
      return out
    },
    open: async (p: never, ...rest: never[]) => {
      const handle = await (fs.promises.open as (...a: unknown[]) => Promise<import('fs/promises').FileHandle>)(p, ...rest)
      if (!isSession(p)) return handle
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key)
          if (key !== 'read') return typeof value === 'function' ? value.bind(target) : value
          return async (...args: unknown[]) => {
            const out = await (value as (...a: unknown[]) => Promise<{ bytesRead: number }>).apply(target, args)
            io.read += out.bytesRead
            return out
          }
        }
      })
    },
    writeFile: async (p: never, data: never, ...rest: never[]) => {
      if (isSession(p)) io.written += size(data)
      return (fs.promises.writeFile as (...a: unknown[]) => Promise<unknown>)(p, data, ...rest)
    }
  }
  return { ...fs, default: { ...fs, readFileSync, writeFileSync, promises }, readFileSync, writeFileSync, promises }
})
vi.mock('fs/promises', async () => (await import('fs')).promises)

import { ClaudeCodeAdapter } from './claude-code-adapter'

const SIZES_MB = [1, 10, 50]
const RUNS = 5
const WORKSPACE = '/work/perf-session'

/** Deterministic, realistic Claude Code JSONL of at least `targetBytes`. */
function buildSessionJsonl(sessionId: string, targetBytes: number): string {
  const lines: string[] = []
  let bytes = 0
  let n = 0
  let parent: string | null = null
  const base = Date.parse('2026-10-01T00:00:00Z')
  const push = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({
      parentUuid: parent, isSidechain: false, userType: 'external', cwd: WORKSPACE, sessionId,
      version: '2.1.0', gitBranch: 'main', timestamp: new Date(base + n * 1000).toISOString(), ...entry
    })
    parent = (entry.uuid as string) ?? parent
    lines.push(line)
    bytes += line.length + 1
    n++
  }
  while (bytes < targetBytes) {
    const turn = n
    push({ type: 'user', uuid: `u-${turn}`, message: { role: 'user', content: [{ type: 'text', text: `Please fix item ${turn}. `.repeat(8) }] } })
    for (let step = 0; step < 6; step++) {
      const id = `msg_${turn}_${step}`
      const toolId = `toolu_${turn}_${step}`
      push({
        type: 'assistant', uuid: `a-${turn}-${step}`, requestId: `req_${turn}_${step}`,
        message: {
          id, type: 'message', role: 'assistant', model: 'claude-opus-4-5',
          content: [
            ...(step === 0 ? [{ type: 'thinking', thinking: 'Let me look at the code first. '.repeat(10), signature: 's'.repeat(200) }] : []),
            { type: 'text', text: `Step ${step}: reading the relevant file and checking the call sites. `.repeat(3) },
            { type: 'tool_use', id: toolId, name: step % 2 ? 'Read' : 'Bash', input: step % 2 ? { file_path: `/work/src/file-${step}.ts` } : { command: `grep -rn item${turn} src`, description: 'Search' } }
          ],
          stop_reason: 'tool_use', usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40000 }
        }
      })
      const outLen = 200 + ((turn * 7 + step * 131) % 8000)
      push({
        type: 'user', uuid: `r-${turn}-${step}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x'.repeat(outLen), is_error: false }] },
        toolUseResult: { stdout: 'x'.repeat(Math.min(outLen, 2000)), stderr: '', interrupted: false }
      })
    }
    if (turn % 5 === 0) push({ type: 'file-history-snapshot', messageId: `u-${turn}`, snapshot: { trackedFileBackups: {} } })
  }
  return lines.join('\n') + '\n'
}

/** Longest gap between ticks of a 1 ms timer while `fn` runs = longest main-thread block. */
async function withBlockProbe<T>(fn: () => Promise<T>): Promise<{ result: T; maxBlockMs: number }> {
  let last = performance.now()
  let maxBlockMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxBlockMs = Math.max(maxBlockMs, now - last)
    last = now
  }, 1)
  try {
    last = performance.now()
    const result = await fn()
    maxBlockMs = Math.max(maxBlockMs, performance.now() - last)
    return { result, maxBlockMs }
  } finally {
    clearInterval(timer)
  }
}

const results: Record<string, string | number> = {}
afterAll(() => printResults('claude-code resumeSession from a JSONL session file (median of 5)', results))

describe('claude-code session file resume benchmark', { timeout: 300_000 }, () => {
  for (const mb of SIZES_MB) {
    it(`resumes a ${mb} MB session`, async () => {
      const home = mkdtempSync(join(tmpdir(), '20x-session-perf-'))
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        const sessionId = '0b0e7f3c-1d2e-4f5a-8b9c-0123456789ab'
        const dir = join(home, 'projects', WORKSPACE.replace(/[^a-zA-Z0-9-]/g, '-'))
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${sessionId}.jsonl`)
        const jsonl = buildSessionJsonl(sessionId, mb * 1024 * 1024)
        writeFileSync(file, jsonl)
        const fileBytes = statSync(file).size

        const adapter = new ClaudeCodeAdapter({ harnessHome: home })
        const config = { agentId: 'a', taskId: 't', workspaceDir: WORKSPACE, harnessHome: home }
        const wall: number[] = []
        const block: number[] = []
        let messages = 0
        let read = 0
        let written = 0
        for (let i = 0; i < RUNS + 1; i++) {
          io.read = 0
          io.written = 0
          const start = performance.now()
          const { result, maxBlockMs } = await withBlockProbe(() => adapter.resumeSession(sessionId, config as never))
          if (i === 0) continue // warm-up
          wall.push(performance.now() - start)
          block.push(maxBlockMs)
          messages = result.length
          read = io.read
          written = io.written
        }
        // Nothing to clean: the file is unchanged.
        expect(statSync(file).size).toBe(fileBytes)
        expect(messages).toBeGreaterThan(0)
        // Read once, never rewritten when there is nothing to clean.
        expect(read).toBe(fileBytes)
        expect(written).toBe(0)

        const label = `${(fileBytes / 1024 / 1024).toFixed(0)} MB (${messages} messages)`
        results[`${label}: wall ms`] = median(wall).toFixed(1)
        results[`${label}: longest main-thread block ms`] = median(block).toFixed(1)
        results[`${label}: MB read / written`] = `${(read / 1024 / 1024).toFixed(1)} / ${(written / 1024 / 1024).toFixed(1)}`
      } finally {
        log.mockRestore()
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
