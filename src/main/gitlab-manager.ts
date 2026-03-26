import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import type { GitHubRepo } from './github-manager'

const execFileAsync = promisify(execFile)

const GLAB_API_MAX_BUFFER = 10 * 1024 * 1024

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export class GitLabManager {
  private authProcess: ChildProcess | null = null

  /**
   * Maps a raw GitLab API project object to the shared GitHubRepo interface
   * so the UI can handle both providers uniformly.
   */
  private mapRepo(raw: Record<string, unknown>): GitHubRepo {
    const pathWithNamespace = raw.path_with_namespace as string
    const httpUrl = raw.http_url_to_repo as string
    return {
      name: raw.path as string,
      fullName: pathWithNamespace,
      defaultBranch: (raw.default_branch as string) || 'main',
      cloneUrl: httpUrl,
      description: (raw.description as string) || '',
      isPrivate: (raw.visibility as string) === 'private'
    }
  }

  /**
   * Fetches all projects accessible to the authenticated user via the GitLab REST API.
   * Uses glab to proxy the request so authentication tokens are handled automatically.
   */
  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    const allRepos: GitHubRepo[] = []
    let page = 1
    const perPage = 100

    // glab api does not support --paginate like gh, so we paginate manually
    while (true) {
      const { stdout } = await execFileAsync('glab', [
        'api', '/projects',
        '--method', 'GET',
        '-f', `membership=true`,
        '-f', `per_page=${perPage}`,
        '-f', `page=${page}`,
        '-f', 'order_by=updated_at',
        '-f', 'sort=desc'
      ], { maxBuffer: GLAB_API_MAX_BUFFER })

      const raw = JSON.parse(stdout) as Record<string, unknown>[]
      if (raw.length === 0) break

      for (const project of raw) {
        allRepos.push(this.mapRepo(project))
      }

      if (raw.length < perPage) break
      page++
    }

    // Deduplicate by fullName
    const deduped = new Map<string, GitHubRepo>()
    for (const repo of allRepos) {
      deduped.set(repo.fullName, repo)
    }
    return Array.from(deduped.values())
  }

  async checkGlabCli(): Promise<GlabCliStatus> {
    try {
      await execFileAsync('glab', ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync('glab', ['auth', 'status'])
      // glab auth status outputs "Logged in to <hostname> as <username>"
      const match = stdout.match(/Logged in to .+ as (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      const execErr = error as { stderr?: string; stdout?: string }
      const output = (execErr?.stderr || '') + (execErr?.stdout || '')
      if (output.includes('Logged in')) {
        const match = output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async startWebAuth(onDeviceCode?: (code: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authProcess = spawn(
        'glab',
        ['auth', 'login', '--hostname', 'gitlab.com'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )

      let completed = false
      let browserOpened = false
      let output = ''
      const timeout = setTimeout(() => {
        if (!completed) {
          this.authProcess?.kill()
          reject(new Error('Auth timeout'))
        }
      }, 120000)

      const handleOutput = (data: Buffer): void => {
        output += data.toString()

        // glab uses a web-based flow similar to gh
        if (onDeviceCode) {
          const codeMatch = output.match(/code:\s*([A-Z0-9-]+)/)
          if (codeMatch) {
            onDeviceCode(codeMatch[1])
          }
        }

        if (!browserOpened) {
          const urlMatch = output.match(/(https:\/\/gitlab\.com\/\S+)/)
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
        else reject(new Error(`glab auth login exited with code ${code}`))
      })

      this.authProcess.on('error', (err) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        reject(err)
      })

      // Write newline for any potential prompts
      this.authProcess.stdin?.write('\n')
    })
  }

  /**
   * Fetches all unique groups/namespaces the authenticated user has access to.
   * Mirrors GitHubManager.fetchUserOrgs() for UI compatibility.
   */
  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGlabCli(),
      this.fetchAccessibleRepos()
    ])

    const owners = new Set<string>()
    for (const repo of repos) {
      // GitLab uses nested namespaces (e.g. "group/subgroup/project")
      // We extract the top-level namespace (first segment)
      const parts = repo.fullName.split('/')
      if (parts.length >= 2) {
        const owner = parts[0]
        if (owner && owner !== status.username) {
          owners.add(owner)
        }
      }
    }

    return Array.from(owners).sort((left, right) => left.localeCompare(right))
  }

  /**
   * Fetches repos for a specific organization/group.
   * Uses prefix matching similar to GitHubManager.fetchOrgRepos().
   */
  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
  }

  /**
   * Fetches repos owned by the authenticated user.
   */
  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const status = await this.checkGlabCli()
    if (!status.username) return []

    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${status.username}/`))
  }
}
