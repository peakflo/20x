import { promisify } from 'util'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

execFileMock[promisify.custom] = (...args: unknown[]) => {
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

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}))

import { GitHubManager } from './github-manager'

describe('GitHubManager', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('derives owners from accessible repos when org membership is missing', async () => {
    execFileMock.mockImplementation((file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

      expect(file).toBe('gh')

      if (args[0] === '--version') {
        callback(null, 'gh version 2.0.0', '')
        return
      }

      if (args[0] === 'auth' && args[1] === 'status') {
        callback(null, 'Logged in to github.com account dmitry', '')
        return
      }

      if (args[0] === 'api' && args[1] === '--paginate' && args[2] === '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member') {
        callback(null, JSON.stringify([
          {
            name: 'agent-app',
            full_name: 'acme/agent-app',
            default_branch: 'main',
            clone_url: 'https://github.com/acme/agent-app.git',
            description: 'Shared repo',
            private: true
          },
          {
            name: '20x',
            full_name: 'dmitry/20x',
            default_branch: 'main',
            clone_url: 'https://github.com/dmitry/20x.git',
            description: 'Personal repo',
            private: false
          }
        ]), '')
        return
      }

      callback(new Error(`Unexpected gh call: ${args.join(' ')}`))
    })

    const manager = new GitHubManager()

    await expect(manager.fetchUserOrgs()).resolves.toEqual(['acme'])
    await expect(manager.fetchOrgRepos('acme')).resolves.toEqual([
      expect.objectContaining({ fullName: 'acme/agent-app' })
    ])
    await expect(manager.fetchUserRepos()).resolves.toEqual([
      expect.objectContaining({ fullName: 'dmitry/20x' })
    ])

    expect(execFileMock).not.toHaveBeenCalledWith(
      'gh',
      ['api', '/user/orgs', '--jq', '.[].login'],
      expect.anything()
    )
  })
})
