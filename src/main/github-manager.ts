import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import { guardChildStreams, writeToChildStdin } from './child-stream-guards'
import {
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type PullRequestCheck,
  type PullRequestDetails
} from '../shared/artifacts'
import {
  parseWatchablePullRequestUrl,
  type PullRequestCheckSnapshot,
  type PullRequestCommentSnapshot,
  type PullRequestWatchSnapshot
} from './pull-request-watch'

const execFileAsync = promisify(execFile)

const GH_API_MAX_BUFFER = 10 * 1024 * 1024
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i

export interface GhCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  cloneUrl: string
  description: string
  isPrivate: boolean
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: string
  assignees: { login: string }[]
  labels: { name: string }[]
  milestone: { due_on: string | null } | null
  pull_request?: unknown
  created_at: string
  updated_at: string
}

export interface GitHubCollaborator {
  login: string
  avatar_url: string
  type: string
}

interface RawPullRequestCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawPullRequestDetails {
  url?: string
  number?: number
  title?: string
  body?: string
  state?: string
  isDraft?: boolean
  mergeStateStatus?: string
  reviewDecision?: string
  author?: { login?: string; avatarUrl?: string; url?: string }
  baseRefName?: string
  headRefName?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  comments?: unknown[]
  reviews?: unknown[]
  createdAt?: string
  updatedAt?: string
  mergedAt?: string
  closedAt?: string
  statusCheckRollup?: RawPullRequestCheck[]
}

function mapPullRequestState(value?: string): PullRequestState {
  if (value?.toUpperCase() === 'MERGED') return PullRequestState.MERGED
  if (value?.toUpperCase() === 'CLOSED') return PullRequestState.CLOSED
  return PullRequestState.OPEN
}

function mapReviewDecision(value?: string): PullRequestReviewDecision {
  switch (value?.toUpperCase()) {
    case 'APPROVED': return PullRequestReviewDecision.APPROVED
    case 'CHANGES_REQUESTED': return PullRequestReviewDecision.CHANGES_REQUESTED
    case 'REVIEW_REQUIRED': return PullRequestReviewDecision.REVIEW_REQUIRED
    default: return PullRequestReviewDecision.NONE
  }
}

function mapCheckState(check: RawPullRequestCheck): PullRequestCheckState {
  const value = (check.conclusion || check.state || check.status || '').toUpperCase()
  if (['SUCCESS'].includes(value)) return PullRequestCheckState.PASSED
  if (['NEUTRAL', 'SKIPPED'].includes(value)) return PullRequestCheckState.SKIPPED
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) {
    return PullRequestCheckState.FAILED
  }
  return PullRequestCheckState.PENDING
}

function mapPullRequestCheck(check: RawPullRequestCheck): PullRequestCheck {
  return {
    name: check.name || check.context || 'Check',
    state: mapCheckState(check),
    url: check.detailsUrl || check.targetUrl || undefined
  }
}

export class GitHubManager {
  private authProcess: ChildProcess | null = null
  private viewerLogin: string | null = null

  private mapRepo(raw: Record<string, unknown>): GitHubRepo {
    return {
      name: raw.name as string,
      fullName: raw.full_name as string,
      defaultBranch: (raw.default_branch as string) || 'main',
      cloneUrl: raw.clone_url as string,
      description: (raw.description as string) || '',
      isPrivate: raw.private as boolean
    }
  }

  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
    ], { maxBuffer: GH_API_MAX_BUFFER })

    const raw = JSON.parse(stdout) as Record<string, unknown>[]
    const deduped = new Map<string, GitHubRepo>()

    for (const repo of raw) {
      const mapped = this.mapRepo(repo)
      deduped.set(mapped.fullName, mapped)
    }

    return Array.from(deduped.values())
  }

  async checkGhCli(): Promise<GhCliStatus> {
    try {
      await execFileAsync('gh', ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'status', '--active'])
      const match = stdout.match(/Logged in to .+ account (\S+)/) ||
                    stdout.match(/account (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      // gh auth status exits with 1 when not authenticated, but may still output to stderr
      const execErr = error as { stderr?: string; stdout?: string }
      const output = execErr?.stderr || execErr?.stdout || ''
      if (output.includes('Logged in')) {
        const match = output.match(/account (\S+)/) || output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async startWebAuth(onDeviceCode?: (code: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authProcess = spawn(
        'gh',
        ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )

      // Every pipe needs an error listener before the first write; a CLI that
      // exits early must not crash the main process with EPIPE.
      guardChildStreams(this.authProcess, 'GitHubManager')

      let completed = false
      let browserOpened = false
      let codeEmitted = false
      let output = ''
      const timeout = setTimeout(() => {
        if (!completed) {
          this.authProcess?.kill()
          reject(new Error('Auth timeout'))
        }
      }, 120000)

      const handleOutput = (data: Buffer): void => {
        output += data.toString()

        if (!codeEmitted && onDeviceCode) {
          const codeMatch = output.match(/code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)
          if (codeMatch) {
            codeEmitted = true
            onDeviceCode(codeMatch[1])
          }
        }

        if (!browserOpened) {
          const urlMatch = output.match(/(https:\/\/github\.com\/login\/device\S*)/)
          if (urlMatch) {
            browserOpened = true
            shell.openExternal(urlMatch[1])
          }
        }
      }

      this.authProcess.stderr?.on('data', handleOutput)
      this.authProcess.stdout?.on('data', handleOutput)

      this.authProcess.on('close', (code) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        if (code === 0) resolve()
        else reject(new Error(`gh auth login exited with code ${code}`))
      })

      this.authProcess.on('error', (err) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        reject(err)
      })

      // Write newline for any potential "Press Enter" prompts. `gh` may have
      // already exited, so the write must never throw.
      writeToChildStdin(this.authProcess, '\n', 'GitHubManager')
    })
  }

  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGhCli(),
      this.fetchAccessibleRepos()
    ])

    const owners = new Set<string>()
    for (const repo of repos) {
      const [owner] = repo.fullName.split('/')
      if (owner && owner !== status.username) {
        owners.add(owner)
      }
    }

    return Array.from(owners).sort((left, right) => left.localeCompare(right))
  }

  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
  }

  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const status = await this.checkGhCli()
    if (!status.username) return []

    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${status.username}/`))
  }

  async fetchPullRequestDetails(url: string): Promise<PullRequestDetails> {
    const match = url.match(GITHUB_PULL_REQUEST_URL)
    if (!match) throw new Error('A valid GitHub pull request URL is required')

    const [, owner, repo, number] = match
    const { stdout } = await execFileAsync('gh', [
      'pr', 'view', url,
      '--json',
      'url,number,title,body,state,isDraft,mergeStateStatus,reviewDecision,author,baseRefName,headRefName,additions,deletions,changedFiles,comments,reviews,createdAt,updatedAt,mergedAt,closedAt,statusCheckRollup'
    ], { maxBuffer: GH_API_MAX_BUFFER })
    const raw = JSON.parse(stdout) as RawPullRequestDetails

    return {
      url: raw.url || url,
      repository: `${owner}/${repo}`,
      number: raw.number || Number(number),
      title: raw.title || `Pull request #${number}`,
      body: raw.body || '',
      state: mapPullRequestState(raw.state),
      isDraft: raw.isDraft === true,
      mergeStateStatus: raw.mergeStateStatus || undefined,
      reviewDecision: mapReviewDecision(raw.reviewDecision),
      author: {
        login: raw.author?.login || 'unknown',
        avatarUrl: raw.author?.avatarUrl || undefined,
        url: raw.author?.url || undefined
      },
      baseRefName: raw.baseRefName || '',
      headRefName: raw.headRefName || '',
      additions: raw.additions || 0,
      deletions: raw.deletions || 0,
      changedFiles: raw.changedFiles || 0,
      commentsCount: raw.comments?.length || 0,
      reviewsCount: raw.reviews?.length || 0,
      createdAt: raw.createdAt || '',
      updatedAt: raw.updatedAt || '',
      mergedAt: raw.mergedAt || undefined,
      closedAt: raw.closedAt || undefined,
      checks: (raw.statusCheckRollup || []).map(mapPullRequestCheck)
    }
  }

  async fetchIssues(
    owner: string,
    repo: string,
    opts: { state?: string; assignee?: string; labels?: string } = {}
  ): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({
      per_page: '100',
      state: opts.state || 'open'
    })
    if (opts.assignee) params.set('assignee', opts.assignee)
    if (opts.labels) params.set('labels', opts.labels)

    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/repos/${owner}/${repo}/issues?${params.toString()}`
    ], { maxBuffer: 10 * 1024 * 1024 })

    const raw = JSON.parse(stdout) as GitHubIssue[]
    // Filter out pull requests (GitHub issues API includes them)
    return raw.filter((issue) => !issue.pull_request)
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    data: { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] }
  ): Promise<void> {
    const args = ['api', '-X', 'PATCH', `/repos/${owner}/${repo}/issues/${number}`]
    for (const [key, val] of Object.entries(data)) {
      if (val === undefined) continue
      if (Array.isArray(val)) {
        // Use --raw-field for JSON arrays
        args.push('--raw-field', `${key}=${JSON.stringify(val)}`)
      } else {
        args.push('-f', `${key}=${val}`)
      }
    }
    await execFileAsync('gh', args)
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await execFileAsync('gh', [
      'api', '-X', 'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      '-f', `body=${body}`
    ])
  }

  /** GitHub login of the account `gh` is signed in as, cached for the process. */
  async fetchViewerLogin(): Promise<string> {
    if (this.viewerLogin) return this.viewerLogin
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'])
    this.viewerLogin = stdout.trim()
    return this.viewerLogin
  }

  /**
   * Read what the PR watcher compares between polls: state, head commit,
   * mergeable state, check results and new review activity. Comments written by
   * the signed-in account are left out, so the agent's own replies never wake it.
   */
  async fetchPullRequestWatchSnapshot(url: string): Promise<PullRequestWatchSnapshot> {
    const parsed = parseWatchablePullRequestUrl(url)
    if (!parsed) throw new Error('A valid GitHub pull request URL is required')
    const { owner, repo, number, url: canonicalUrl } = parsed
    const viewer = await this.fetchViewerLogin().catch(() => '')

    const [{ stdout: viewStdout }, reviewComments, issueComments, reviews] = await Promise.all([
      execFileAsync('gh', [
        'pr', 'view', canonicalUrl,
        '--json', 'state,isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup,url'
      ], { maxBuffer: GH_API_MAX_BUFFER }),
      this.fetchGhApiArray(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
      this.fetchGhApiArray(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`),
      this.fetchGhApiArray(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`)
    ])

    const raw = JSON.parse(viewStdout) as {
      state?: string
      isDraft?: boolean
      headRefOid?: string
      mergeable?: string
      reviewDecision?: string
      statusCheckRollup?: RawPullRequestCheck[]
    }

    const checks = (raw.statusCheckRollup || []).map((check): PullRequestCheckSnapshot => {
      // CheckRun reports status + conclusion. A commit status (StatusContext) reports one state.
      if (check.__typename === 'StatusContext' || (!check.status && check.state)) {
        const state = (check.state || '').toUpperCase()
        return {
          name: check.context || check.name || 'Status',
          completed: !['PENDING', 'EXPECTED', ''].includes(state),
          conclusion: state,
          url: check.targetUrl || undefined
        }
      }
      return {
        name: check.name || check.context || 'Check',
        completed: (check.status || '').toUpperCase() === 'COMPLETED',
        conclusion: (check.conclusion || '').toUpperCase(),
        url: check.detailsUrl || undefined
      }
    })

    const comments: PullRequestCommentSnapshot[] = []
    const authorOf = (item: { user?: { login?: string } | null }): string => item.user?.login || 'unknown'
    const isOwn = (item: { user?: { login?: string } | null }): boolean => !!viewer && authorOf(item) === viewer

    for (const item of reviewComments) {
      if (isOwn(item)) continue
      comments.push({
        kind: 'review_comment',
        id: String(item.id),
        author: authorOf(item),
        body: String(item.body || ''),
        path: typeof item.path === 'string' ? item.path : undefined,
        line: typeof item.line === 'number' ? item.line : (typeof item.original_line === 'number' ? item.original_line : undefined),
        url: typeof item.html_url === 'string' ? item.html_url : undefined
      })
    }
    for (const item of issueComments) {
      if (isOwn(item)) continue
      comments.push({
        kind: 'issue_comment',
        id: String(item.id),
        author: authorOf(item),
        body: String(item.body || ''),
        url: typeof item.html_url === 'string' ? item.html_url : undefined
      })
    }
    for (const item of reviews) {
      if (isOwn(item)) continue
      const state = String(item.state || '').toUpperCase()
      const body = String(item.body || '')
      // Approvals and dismissals carry no request. Only changes requested or a
      // written review are worth waking the agent for.
      if (state !== 'CHANGES_REQUESTED' && !(state === 'COMMENTED' && body.trim())) continue
      comments.push({
        kind: 'review',
        id: String(item.id),
        author: authorOf(item),
        body: state === 'CHANGES_REQUESTED' && !body.trim() ? 'Changes requested.' : body,
        url: typeof item.html_url === 'string' ? item.html_url : undefined
      })
    }

    return {
      url: canonicalUrl,
      state: (raw.state || 'OPEN').toUpperCase() as PullRequestWatchSnapshot['state'],
      isDraft: raw.isDraft === true,
      headSha: raw.headRefOid || '',
      mergeable: (raw.mergeable || 'UNKNOWN').toUpperCase(),
      reviewDecision: (raw.reviewDecision || '').toUpperCase(),
      checks,
      comments
    }
  }

  private async fetchGhApiArray(path: string): Promise<Array<Record<string, unknown> & { user?: { login?: string } | null }>> {
    const { stdout } = await execFileAsync('gh', ['api', '--paginate', path], { maxBuffer: GH_API_MAX_BUFFER })
    const parsed = JSON.parse(stdout) as unknown
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown> & { user?: { login?: string } | null }> : []
  }

  async fetchRepoCollaborators(owner: string, repo: string): Promise<GitHubCollaborator[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/repos/${owner}/${repo}/collaborators?per_page=100`
    ])
    return JSON.parse(stdout) as GitHubCollaborator[]
  }
}
