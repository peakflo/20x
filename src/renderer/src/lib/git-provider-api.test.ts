import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getGitProviderApi, getProviderLabel } from './git-provider-api'

// Mock the ipc-client module
vi.mock('./ipc-client', () => ({
  githubApi: {
    checkCli: vi.fn(),
    fetchOrgs: vi.fn(),
    fetchOrgRepos: vi.fn(),
    fetchUserRepos: vi.fn()
  },
  gitlabApi: {
    checkCli: vi.fn(),
    fetchOrgs: vi.fn(),
    fetchOrgRepos: vi.fn(),
    fetchUserRepos: vi.fn()
  }
}))

describe('getGitProviderApi', () => {
  it('returns github API when provider is null', () => {
    const api = getGitProviderApi(null)
    // Should return github functions (not throw)
    expect(api.checkCli).toBeDefined()
    expect(api.fetchOrgs).toBeDefined()
    expect(api.fetchOrgRepos).toBeDefined()
    expect(api.fetchUserRepos).toBeDefined()
  })

  it('returns github API when provider is "github"', () => {
    const api = getGitProviderApi('github')
    expect(api.checkCli).toBeDefined()
  })

  it('returns gitlab API when provider is "gitlab"', () => {
    const api = getGitProviderApi('gitlab')
    expect(api.checkCli).toBeDefined()
  })

  it('returns different API instances for different providers', async () => {
    const ghApi = getGitProviderApi('github')
    const glApi = getGitProviderApi('gitlab')
    // They should be different objects referencing different underlying APIs
    expect(ghApi.checkCli).not.toBe(glApi.checkCli)
  })
})

describe('getProviderLabel', () => {
  it('returns "GitHub" for null', () => {
    expect(getProviderLabel(null)).toBe('GitHub')
  })

  it('returns "GitHub" for github', () => {
    expect(getProviderLabel('github')).toBe('GitHub')
  })

  it('returns "GitLab" for gitlab', () => {
    expect(getProviderLabel('gitlab')).toBe('GitLab')
  })
})
