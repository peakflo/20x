import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, statSync } from 'fs'
import {
  startSecretBroker,
  stopSecretBroker,
  registerSecretSession,
  unregisterSecretSession,
  getSecretBrokerPort,
  writeSecretLoaderScript,
  writeSecretTokenFile,
  deleteSecretTokenFile,
  shellQuote
} from './secret-broker'
import type { DatabaseManager } from './database'

const execFileAsync = promisify(execFile)

function makeFakeDb(secretsByIds: Record<string, Array<{ env_var_name: string; value: string }>>) {
  return {
    getSecretsWithValues: vi.fn((ids: string[]) => {
      const key = ids.join(',')
      return secretsByIds[key] ?? []
    })
  } as unknown as DatabaseManager
}

async function fetchExport(port: number, token: string | null, opts?: { viaQuery?: boolean }): Promise<{ status: number; body: string }> {
  const url = opts?.viaQuery
    ? `http://127.0.0.1:${port}/secrets/export?token=${encodeURIComponent(token ?? '')}`
    : `http://127.0.0.1:${port}/secrets/export`
  const res = await fetch(url, {
    headers: token && !opts?.viaQuery ? { Authorization: `Bearer ${token}` } : {}
  })
  const body = await res.text()
  return { status: res.status, body }
}

describe('secret broker', () => {
  afterEach(() => {
    stopSecretBroker()
  })

  it('binds to 127.0.0.1 and serves on a random port', async () => {
    const db = makeFakeDb({})
    const port = await startSecretBroker(db)
    expect(port).toBeGreaterThan(0)
    expect(getSecretBrokerPort()).toBe(port)
  })

  it('returns export lines for a valid session token passed in the Authorization header', async () => {
    const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })
    const port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])

    const { status, body } = await fetchExport(port, 'tok-abc')
    expect(status).toBe(200)
    expect(body).toBe(`export MY_SECRET='leaked-value-123456'`)
  })

  it('rejects a token passed in the URL query string — header only', async () => {
    const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })
    const port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])

    const { status, body } = await fetchExport(port, 'tok-abc', { viaQuery: true })
    expect(status).toBe(403)
    expect(body).not.toContain('leaked-value-123456')
  })

  it('rejects a missing token', async () => {
    const db = makeFakeDb({})
    const port = await startSecretBroker(db)
    const { status } = await fetchExport(port, null)
    expect(status).toBe(403)
  })

  it('rejects an unknown/garbage token without crashing (constant-time compare handles length mismatch)', async () => {
    const db = makeFakeDb({})
    const port = await startSecretBroker(db)
    registerSecretSession('short-tok', 'agent-1', [])
    const { status } = await fetchExport(port, 'a-completely-different-and-much-longer-token-value')
    expect(status).toBe(403)
  })

  it('revokes a token immediately — a request right after unregister gets 403', async () => {
    const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })
    const port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])

    expect((await fetchExport(port, 'tok-abc')).status).toBe(200)
    unregisterSecretSession('tok-abc')
    expect((await fetchExport(port, 'tok-abc')).status).toBe(403)
  })

  it('never writes to a fixed shared temp path for an export request', async () => {
    const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })
    const port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])
    await Promise.all([fetchExport(port, 'tok-abc'), fetchExport(port, 'tok-abc'), fetchExport(port, 'tok-abc')])
    expect(existsSync('/tmp/_20x_secrets_body')).toBe(false)
  })

  it('clears all registered sessions on stop', async () => {
    const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })
    const port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])
    stopSecretBroker()

    const port2 = await startSecretBroker(db)
    expect(port2).not.toBe(port) // fresh random port after restart
    const { status } = await fetchExport(port2, 'tok-abc')
    expect(status).toBe(403)
  })
})

describe('writeSecretLoaderScript', () => {
  it('writes a 0755 script on posix and is idempotent', () => {
    const path = writeSecretLoaderScript()
    expect(existsSync(path)).toBe(true)
    const mode = statSync(path).mode & 0o777
    if (process.platform !== 'win32') expect(mode).toBe(0o755)

    const contents1 = readFileSync(path, 'utf-8')
    const path2 = writeSecretLoaderScript()
    expect(path2).toBe(path)
    expect(readFileSync(path, 'utf-8')).toBe(contents1)
  })

  it('the loader source never echoes its own args and never enables -x', () => {
    const path = writeSecretLoaderScript()
    const source = readFileSync(path, 'utf-8')
    expect(source).not.toMatch(/set -x/)
    expect(source).not.toMatch(/\becho\b[^\n]*\$\*/)
    expect(source).not.toMatch(/\becho\b[^\n]*\$@/)
  })
})

describe('shellQuote', () => {
  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's a token")).toBe(`'it'\\''s a token'`)
  })

  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('plain-token-123')).toBe(`'plain-token-123'`)
  })
})

// Integration: actually run the generated loader script against a live
// broker (posix only — this dev machine is darwin/linux; CI runners for this
// repo are posix too). Confirms end-to-end: valid token -> export lines on
// stdout and nothing on stderr; broker down -> nothing on stdout, a clear
// message on stderr, non-zero exit — "fails closed with a clear error".
describe.skipIf(process.platform === 'win32')('secret-loader.sh end-to-end', () => {
  let port: number
  const db = makeFakeDb({ 's1': [{ env_var_name: 'MY_SECRET', value: 'leaked-value-123456' }] })

  beforeEach(async () => {
    port = await startSecretBroker(db)
    registerSecretSession('tok-abc', 'agent-1', ['s1'])
  })
  afterEach(() => stopSecretBroker())

  it('prints only export lines to stdout for a valid token, nothing to stderr', async () => {
    const loaderPath = writeSecretLoaderScript()
    const tokenFile = writeSecretTokenFile('tok-abc')
    const { stdout, stderr } = await execFileAsync(loaderPath, [String(port), tokenFile])
    expect(stdout.trim()).toBe(`export MY_SECRET='leaked-value-123456'`)
    expect(stderr.trim()).toBe('')
  })

  it('fails closed with nothing on stdout and a clear message on stderr when the broker is unreachable', async () => {
    const loaderPath = writeSecretLoaderScript()
    const tokenFile = writeSecretTokenFile('tok-abc')
    // Stop our own broker so this port is DEFINITELY not listening — picking
    // an arbitrary nearby port number is flaky under a full parallel test
    // run, where some other test's server can legitimately be bound there.
    const deadPort = port
    stopSecretBroker()
    try {
      await execFileAsync(loaderPath, [String(deadPort), tokenFile])
      throw new Error('expected the loader to fail')
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string }
      expect(e.code).toBe(1)
      expect(e.stdout.trim()).toBe('')
      expect(e.stderr).toContain('failing closed')
    }
  })

  it('fails closed when given a wrong token — no secret value leaks to stdout', async () => {
    const loaderPath = writeSecretLoaderScript()
    const wrongTokenFile = writeSecretTokenFile('wrong-token')
    try {
      await execFileAsync(loaderPath, [String(port), wrongTokenFile])
      throw new Error('expected failure')
    } catch (err) {
      const e = err as { stdout: string; stderr: string; code: number }
      expect(e.stdout.trim()).toBe('')
      expect(e.stdout).not.toContain('leaked-value-123456')
    }
  })

  // P1 finding, re-review: the token used to be passed to the loader as a
  // plain argv entry, visible via `ps -ef`/`ps eww` for the whole time the
  // loader process ran. It's now read from a 0600 file whose PATH is the
  // argv entry instead.
  it("reads the token from a file — the raw token value never appears in the loader's own argv", async () => {
    const loaderPath = writeSecretLoaderScript()
    const tokenFile = writeSecretTokenFile('tok-abc')
    expect(tokenFile).not.toContain('tok-abc') // the path itself doesn't leak the token
    const { stdout } = await execFileAsync(loaderPath, [String(port), tokenFile])
    expect(stdout.trim()).toBe(`export MY_SECRET='leaked-value-123456'`)
  })

  it('fails closed with a clear message when the token file does not exist', async () => {
    const loaderPath = writeSecretLoaderScript()
    try {
      await execFileAsync(loaderPath, [String(port), '/tmp/20x-nonexistent-token-file-xyz'])
      throw new Error('expected failure')
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string }
      expect(e.stdout.trim()).toBe('')
      expect(e.stderr).toContain('token file not found')
    }
  })

  it('writeSecretTokenFile writes a 0600 file, and deleteSecretTokenFile removes it', () => {
    const tokenFile = writeSecretTokenFile('tok-cleanup-test')
    expect(existsSync(tokenFile)).toBe(true)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(tokenFile, 'utf-8')).toBe('tok-cleanup-test')

    deleteSecretTokenFile('tok-cleanup-test')
    expect(existsSync(tokenFile)).toBe(false)
  })

  it('deleteSecretTokenFile is a no-op for a token that was never written', () => {
    expect(() => deleteSecretTokenFile('never-written-token')).not.toThrow()
  })
})
