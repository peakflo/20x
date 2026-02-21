import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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

export class GitHubManager {
  private authProcess: ChildProcess | null = null

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
    } catch (error: any) {
      // gh auth status exits with 1 when not authenticated, but may still output to stderr
      const output = error?.stderr || error?.stdout || ''
      if (output.includes('Logged in')) {
        const match = output.match(/account (\S+)/) || output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async startWebAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authProcess = spawn('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let completed = false
      const timeout = setTimeout(() => {
        if (!completed) {
          this.authProcess?.kill()
          reject(new Error('Auth timeout'))
        }
      }, 120000)

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

      // Automatically press Enter for any prompts by writing newlines
      this.authProcess.stdin?.write('\n')
    })
  }

  async fetchUserOrgs(): Promise<string[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '/user/orgs', '--jq', '.[].login'
    ])
    return stdout.trim().split('\n').filter(Boolean)
  }

  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/orgs/${org}/repos?per_page=100&sort=updated`
    ], { maxBuffer: 10 * 1024 * 1024 })

    const raw = JSON.parse(stdout) as any[]
    return raw.map((r) => ({
      name: r.name,
      fullName: r.full_name,
      defaultBranch: r.default_branch || 'main',
      cloneUrl: r.clone_url,
      description: r.description || '',
      isPrivate: r.private
    }))
  }

  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      '/user/repos?per_page=100&sort=updated&affiliation=owner'
    ], { maxBuffer: 10 * 1024 * 1024 })

    const raw = JSON.parse(stdout) as any[]
    return raw.map((r) => ({
      name: r.name,
      fullName: r.full_name,
      defaultBranch: r.default_branch || 'main',
      cloneUrl: r.clone_url,
      description: r.description || '',
      isPrivate: r.private
    }))
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

  async fetchRepoCollaborators(owner: string, repo: string): Promise<GitHubCollaborator[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/repos/${owner}/${repo}/collaborators?per_page=100`
    ])
    return JSON.parse(stdout) as GitHubCollaborator[]
  }
}
