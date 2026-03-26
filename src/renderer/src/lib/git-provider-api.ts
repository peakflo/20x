/**
 * Unified Git provider API that delegates to GitHub or GitLab
 * based on the user's configured git_provider setting.
 */
import { githubApi, gitlabApi } from './ipc-client'
import type { GhCliStatus, GitHubRepo } from '@/types/electron'
import type { GitProvider } from '@/stores/settings-store'

export interface GitProviderApi {
  checkCli: () => Promise<GhCliStatus>
  fetchOrgs: () => Promise<string[]>
  fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
  fetchUserRepos: () => Promise<GitHubRepo[]>
}

/**
 * Returns the appropriate API client for the given provider.
 * Defaults to GitHub if provider is not set.
 */
export function getGitProviderApi(provider: GitProvider | null): GitProviderApi {
  if (provider === 'gitlab') {
    return {
      checkCli: gitlabApi.checkCli,
      fetchOrgs: gitlabApi.fetchOrgs,
      fetchOrgRepos: gitlabApi.fetchOrgRepos,
      fetchUserRepos: gitlabApi.fetchUserRepos
    }
  }

  // Default: GitHub
  return {
    checkCli: githubApi.checkCli,
    fetchOrgs: githubApi.fetchOrgs,
    fetchOrgRepos: githubApi.fetchOrgRepos,
    fetchUserRepos: githubApi.fetchUserRepos
  }
}

/**
 * Returns a human-readable label for the provider.
 */
export function getProviderLabel(provider: GitProvider | null): string {
  return provider === 'gitlab' ? 'GitLab' : 'GitHub'
}
