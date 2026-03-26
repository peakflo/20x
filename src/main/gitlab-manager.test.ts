import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn()
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')

  execFileMock[customPromisify] = (...args: unknown[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const callback = (error: Error | null, stdout = '', stderr = '') => {
        if (error) {
          reject(error)
          return
        }

        resolve({ stdout, stderr })
      }

      execFileMock(...args, callback)
    })
  }

  return { execFileMock }
})

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}))

import { GitLabManager } from './gitlab-manager'

describe('GitLabManager', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  describe('checkGlabCli', () => {
    it('returns not installed when glab is not found', async () => {
      execFileMock.mockImplementation((_file: string, _args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof _optionsOrCallback === 'function'
          ? _optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
          : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

        callback(new Error('command not found'))
      })

      const manager = new GitLabManager()
      const result = await manager.checkGlabCli()

      expect(result).toEqual({ installed: false, authenticated: false })
    })

    it('returns installed but not authenticated', async () => {
      execFileMock.mockImplementation((_file: string, args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof _optionsOrCallback === 'function'
          ? _optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
          : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

        if (args[0] === '--version') {
          callback(null, 'glab version 1.36.0', '')
          return
        }

        if (args[0] === 'auth' && args[1] === 'status') {
          callback(new Error('not authenticated'))
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })

      const manager = new GitLabManager()
      const result = await manager.checkGlabCli()

      expect(result).toEqual({ installed: true, authenticated: false })
    })

    it('returns installed and authenticated with username', async () => {
      execFileMock.mockImplementation((_file: string, args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof _optionsOrCallback === 'function'
          ? _optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
          : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

        if (args[0] === '--version') {
          callback(null, 'glab version 1.36.0', '')
          return
        }

        if (args[0] === 'auth' && args[1] === 'status') {
          callback(null, 'Logged in to gitlab.com as dmitry', '')
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })

      const manager = new GitLabManager()
      const result = await manager.checkGlabCli()

      expect(result).toEqual({ installed: true, authenticated: true, username: 'dmitry' })
    })

    it('detects authentication from stderr output', async () => {
      execFileMock.mockImplementation((_file: string, args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof _optionsOrCallback === 'function'
          ? _optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
          : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

        if (args[0] === '--version') {
          callback(null, 'glab version 1.36.0', '')
          return
        }

        if (args[0] === 'auth' && args[1] === 'status') {
          // glab auth status may exit with code 1 but still output to stderr
          const err = new Error('exit code 1') as Error & { stderr: string }
          err.stderr = 'Logged in to gitlab.com as gitlab-user'
          callback(err)
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })

      const manager = new GitLabManager()
      const result = await manager.checkGlabCli()

      expect(result).toEqual({ installed: true, authenticated: true, username: 'gitlab-user' })
    })
  })
})
