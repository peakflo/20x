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
}
