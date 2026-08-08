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

import { GitHubManager } from './github-manager'
import { PullRequestCheckState, PullRequestReviewDecision, PullRequestState } from '../shared/artifacts'

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

  it('fetches and normalizes pull request details', async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      expect(args).toEqual([
        'pr', 'view', 'https://github.com/peakflo/20x/pull/445',
        '--json',
        expect.stringContaining('statusCheckRollup')
      ])
      callback(null, JSON.stringify({
        url: 'https://github.com/peakflo/20x/pull/445',
        number: 445,
        title: 'Task artifacts',
        body: 'Adds artifact previews.',
        state: 'OPEN',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        author: { login: 'octocat', avatarUrl: 'https://avatars.example/octocat', url: 'https://github.com/octocat' },
        baseRefName: 'main',
        headRefName: 'feature/artifacts',
        additions: 120,
        deletions: 15,
        changedFiles: 8,
        comments: [{ id: 1 }],
        reviews: [{ id: 2 }, { id: 3 }],
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-06T00:00:00Z',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }
        ]
      }), '')
    })

    const details = await new GitHubManager().fetchPullRequestDetails('https://github.com/peakflo/20x/pull/445')

    expect(details).toMatchObject({
      repository: 'peakflo/20x',
      number: 445,
      title: 'Task artifacts',
      state: PullRequestState.OPEN,
      reviewDecision: PullRequestReviewDecision.APPROVED,
      additions: 120,
      deletions: 15,
      changedFiles: 8,
      commentsCount: 1,
      reviewsCount: 2
    })
    expect(details.checks.map((check) => check.state)).toEqual([
      PullRequestCheckState.PASSED,
      PullRequestCheckState.PENDING,
      PullRequestCheckState.FAILED
    ])
  })

  it('rejects non-GitHub pull request URLs before invoking the CLI', async () => {
    await expect(new GitHubManager().fetchPullRequestDetails('https://example.com/pull/1')).rejects.toThrow('valid GitHub pull request URL')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
