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

  describe('fetchOrgRepos', () => {
    const mockProjects = [
      {
        path: 'repo-a',
        path_with_namespace: 'myorg/repo-a',
        default_branch: 'main',
        http_url_to_repo: 'https://gitlab.com/myorg/repo-a.git',
        description: 'First repo',
        visibility: 'private'
      },
      {
        path: 'repo-b',
        path_with_namespace: 'myorg/repo-b',
        default_branch: 'develop',
        http_url_to_repo: 'https://gitlab.com/myorg/repo-b.git',
        description: '',
        visibility: 'public'
      },
      {
        path: 'personal-repo',
        path_with_namespace: 'dmitry/personal-repo',
        default_branch: 'main',
        http_url_to_repo: 'https://gitlab.com/dmitry/personal-repo.git',
        description: 'My personal repo',
        visibility: 'private'
      }
    ]

    function setupApiMock(): void {
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

        if (args[0] === 'api' && args[1] === '/projects') {
          // Return projects on first page, empty on second
          const pageArg = args.find((a) => a === 'page=1' || a === '1')
          const pageFieldIdx = args.indexOf('-f')
          let page = 1
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '-f' && args[i + 1]?.startsWith('page=')) {
              page = parseInt(args[i + 1].replace('page=', ''), 10)
            }
          }
          if (page === 1) {
            callback(null, JSON.stringify(mockProjects), '')
          } else {
            callback(null, JSON.stringify([]), '')
          }
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })
    }

    it('filters repos by org prefix', async () => {
      setupApiMock()
      const manager = new GitLabManager()
      const repos = await manager.fetchOrgRepos('myorg')

      expect(repos).toHaveLength(2)
      expect(repos[0].fullName).toBe('myorg/repo-a')
      expect(repos[0].name).toBe('repo-a')
      expect(repos[0].isPrivate).toBe(true)
      expect(repos[1].fullName).toBe('myorg/repo-b')
      expect(repos[1].isPrivate).toBe(false)
    })

    it('returns empty array for unknown org', async () => {
      setupApiMock()
      const manager = new GitLabManager()
      const repos = await manager.fetchOrgRepos('unknown-org')

      expect(repos).toHaveLength(0)
    })

    it('maps GitLab fields to GitHubRepo interface correctly', async () => {
      setupApiMock()
      const manager = new GitLabManager()
      const repos = await manager.fetchOrgRepos('myorg')

      expect(repos[0]).toEqual({
        name: 'repo-a',
        fullName: 'myorg/repo-a',
        defaultBranch: 'main',
        cloneUrl: 'https://gitlab.com/myorg/repo-a.git',
        description: 'First repo',
        isPrivate: true
      })
    })
  })

  describe('fetchUserOrgs', () => {
    it('returns unique org names excluding the authenticated user', async () => {
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

        if (args[0] === 'api' && args[1] === '/projects') {
          let page = 1
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '-f' && args[i + 1]?.startsWith('page=')) {
              page = parseInt(args[i + 1].replace('page=', ''), 10)
            }
          }
          if (page === 1) {
            callback(null, JSON.stringify([
              { path: 'r1', path_with_namespace: 'orgA/r1', default_branch: 'main', http_url_to_repo: 'url', description: '', visibility: 'private' },
              { path: 'r2', path_with_namespace: 'orgB/r2', default_branch: 'main', http_url_to_repo: 'url', description: '', visibility: 'private' },
              { path: 'r3', path_with_namespace: 'orgA/r3', default_branch: 'main', http_url_to_repo: 'url', description: '', visibility: 'private' },
              { path: 'my', path_with_namespace: 'dmitry/my', default_branch: 'main', http_url_to_repo: 'url', description: '', visibility: 'private' }
            ]), '')
          } else {
            callback(null, JSON.stringify([]), '')
          }
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })

      const manager = new GitLabManager()
      const orgs = await manager.fetchUserOrgs()

      expect(orgs).toEqual(['orgA', 'orgB'])
      // dmitry (the authenticated user) should be excluded
      expect(orgs).not.toContain('dmitry')
    })
  })

  describe('fetchUserRepos', () => {
    it('returns repos belonging to the authenticated user', async () => {
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

        if (args[0] === 'api' && args[1] === '/projects') {
          let page = 1
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '-f' && args[i + 1]?.startsWith('page=')) {
              page = parseInt(args[i + 1].replace('page=', ''), 10)
            }
          }
          if (page === 1) {
            callback(null, JSON.stringify([
              { path: 'org-repo', path_with_namespace: 'someorg/org-repo', default_branch: 'main', http_url_to_repo: 'url', description: '', visibility: 'private' },
              { path: 'my-repo', path_with_namespace: 'dmitry/my-repo', default_branch: 'main', http_url_to_repo: 'url', description: 'Personal', visibility: 'public' }
            ]), '')
          } else {
            callback(null, JSON.stringify([]), '')
          }
          return
        }

        callback(new Error(`Unexpected call: ${args.join(' ')}`))
      })

      const manager = new GitLabManager()
      const repos = await manager.fetchUserRepos()

      expect(repos).toHaveLength(1)
      expect(repos[0].fullName).toBe('dmitry/my-repo')
      expect(repos[0].description).toBe('Personal')
    })
  })
})
