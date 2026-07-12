import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)

const BASE_DIR = app.getPath('userData')
const REPOS_DIR = join(BASE_DIR, 'repos')
const WORKSPACES_DIR = join(BASE_DIR, 'workspaces')

export interface WorktreeRepo {
  fullName: string
  defaultBranch: string
  cloneUrl?: string
}

export class WorktreeManager {
  private mainWindow: BrowserWindow | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private sendProgress(taskId: string, repo: string, step: string, done: boolean, error?: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('worktree:progress', { taskId, repo, step, done, error })
    }
  }

  private bareClonePath(org: string, repoName: string): string {
    return join(REPOS_DIR, org, `${repoName}.git`)
  }

  private worktreePath(taskId: string, repoName: string): string {
    return join(WORKSPACES_DIR, taskId, repoName)
  }

  async setupWorkspaceForTask(
    taskId: string,
    repos: WorktreeRepo[],
    org: string,
    provider?: string
  ): Promise<string> {
    const taskDir = join(WORKSPACES_DIR, taskId)
    console.log(`[WorktreeManager] Setting up workspace for task ${taskId}`)
    console.log(`[WorktreeManager]   Task directory: ${taskDir}`)
    console.log(`[WorktreeManager]   Organization: ${org}`)
    console.log(`[WorktreeManager]   Provider: ${provider || 'github'}`)
    console.log(`[WorktreeManager]   Repos to setup: ${repos.map(r => r.fullName).join(', ')}`)

    mkdirSync(taskDir, { recursive: true })

    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      try {
        console.log(`[WorktreeManager] Processing repo: ${repo.fullName}`)
        await this.ensureBareClone(org, repoName, repo.fullName, provider, repo.cloneUrl)
        await this.fetchBareClone(org, repoName)
        await this.createWorktree(taskId, org, repoName, repo.defaultBranch)
        this.sendProgress(taskId, repoName, 'done', true)
      } catch (error: unknown) {
        const errMsg = (error as Error).message
        console.error(`[WorktreeManager] Error setting up ${repo.fullName}:`, errMsg)
        this.sendProgress(taskId, repoName, 'error', true, errMsg)
        throw error
      }
    }

    console.log(`[WorktreeManager] Workspace setup complete: ${taskDir}`)
    return taskDir
  }

  private async ensureBareClone(
    org: string,
    repoName: string,
    fullName: string,
    provider?: string,
    cloneUrl?: string
  ): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)

    if (existsSync(barePath)) {
      console.log(`[WorktreeManager]   Bare clone already exists: ${barePath}`)
      return
    }

    console.log(`[WorktreeManager]   Bare clone not found, creating: ${barePath}`)
    this.sendProgress('', repoName, 'cloning', false)
    const orgDir = join(REPOS_DIR, org)
    mkdirSync(orgDir, { recursive: true })

    if (provider === 'gitlab') {
      console.log(`[WorktreeManager]   Executing: glab repo clone ${fullName} ${barePath} -- --bare`)
      await execFileAsync('glab', ['repo', 'clone', fullName, barePath, '--', '--bare'], {
        timeout: 300000
      })
      // glab bare clone doesn't set fetch refspec — without it, `git fetch origin`
      // only fetches HEAD as FETCH_HEAD and doesn't create remote tracking branches
      // (e.g. origin/main). This breaks worktree creation from origin/<branch>.
      console.log(`[WorktreeManager]   Setting fetch refspec for glab bare clone`)
      await execFileAsync('git', [
        'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'
      ], { cwd: barePath })
    } else {
      const githubCloneTarget = cloneUrl || `https://github.com/${fullName}.git`
      console.log(`[WorktreeManager]   Executing: gh repo clone ${githubCloneTarget} ${barePath} -- --bare`)
      await execFileAsync('gh', ['repo', 'clone', githubCloneTarget, barePath, '--', '--bare'], {
        timeout: 300000
      })
    }
    console.log(`[WorktreeManager]   Bare clone created successfully`)
  }

  private async fetchBareClone(org: string, repoName: string): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)
    console.log(`[WorktreeManager]   Fetching latest from origin`)
    console.log(`[WorktreeManager]   Executing: git fetch origin`)
    console.log(`[WorktreeManager]   CWD: ${barePath}`)
    this.sendProgress('', repoName, 'fetching', false)

    try {
      await execFileAsync('git', ['fetch', 'origin'], {
        cwd: barePath,
        timeout: 120000
      })
      console.log(`[WorktreeManager]   Fetch completed successfully`)
    } catch (err: unknown) {
      console.error(`[WorktreeManager]   Fetch failed:`, (err as Error).message)
      throw err
    }
  }

  /**
   * Resolves the start ref for a bare clone. Tries origin/<branch>, then <branch>, then HEAD.
   */
  private async resolveStartRef(barePath: string, defaultBranch: string): Promise<string> {
    const candidates = [`origin/${defaultBranch}`, defaultBranch, 'HEAD']
    for (const ref of candidates) {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: barePath })
        return ref
      } catch {
        // try next
      }
    }
    throw new Error(`Could not resolve any ref for ${defaultBranch} in ${barePath}`)
  }

  private async createWorktree(
    taskId: string,
    org: string,
    repoName: string,
    defaultBranch: string
  ): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)
    const wtPath = this.worktreePath(taskId, repoName)

    console.log(`[WorktreeManager] Creating worktree for ${repoName}`)
    console.log(`[WorktreeManager]   Bare clone: ${barePath}`)
    console.log(`[WorktreeManager]   Worktree path: ${wtPath}`)
    console.log(`[WorktreeManager]   Default branch: ${defaultBranch}`)

    if (existsSync(wtPath)) {
      console.log(`[WorktreeManager]   Worktree already exists, skipping`)
      return
    }

    this.sendProgress(taskId, repoName, 'creating worktree', false)

    const branchName = `task/${taskId}`

    // Check if branch already exists
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', branchName], {
        cwd: barePath
      })
      if (stdout.trim()) {
        // Branch exists — create worktree from existing branch
        console.log(`[WorktreeManager]   Branch ${branchName} exists, creating worktree from existing branch`)
        console.log(`[WorktreeManager]   Executing: git worktree add ${wtPath} ${branchName}`)
        console.log(`[WorktreeManager]   CWD: ${barePath}`)
        await execFileAsync('git', ['worktree', 'add', wtPath, branchName], {
          cwd: barePath
        })
        console.log(`[WorktreeManager]   Worktree created successfully`)
        return
      }
    } catch (err: unknown) {
      console.log(`[WorktreeManager]   Error checking for existing branch:`, (err as Error).message)
      // ignore — fall through to create new branch
    }

    const startRef = await this.resolveStartRef(barePath, defaultBranch)
    console.log(`[WorktreeManager]   Resolved start ref: ${startRef}`)

    // Create worktree with new branch from resolved ref
    console.log(`[WorktreeManager]   Creating new branch ${branchName} from ${startRef}`)
    console.log(`[WorktreeManager]   Executing: git worktree add ${wtPath} -b ${branchName} ${startRef}`)
    console.log(`[WorktreeManager]   CWD: ${barePath}`)

    try {
      await execFileAsync('git', [
        'worktree', 'add', wtPath, '-b', branchName, startRef
      ], {
        cwd: barePath,
        timeout: 60000
      })
      console.log(`[WorktreeManager]   Worktree created successfully`)
    } catch (err: unknown) {
      const execErr = err as { message: string; stdout?: string; stderr?: string }
      console.error(`[WorktreeManager]   Failed to create worktree:`, execErr.message)
      if (execErr.stdout) console.error(`[WorktreeManager]   stdout:`, execErr.stdout)
      if (execErr.stderr) console.error(`[WorktreeManager]   stderr:`, execErr.stderr)
      throw err
    }
  }

  async cleanupTaskWorkspace(
    taskId: string,
    repos: { fullName: string }[],
    org: string,
    removeTaskDir = true
  ): Promise<void> {
    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      const barePath = this.bareClonePath(org, repoName)
      const wtPath = this.worktreePath(taskId, repoName)

      if (existsSync(barePath) && existsSync(wtPath)) {
        try {
          await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], {
            cwd: barePath
          })
        } catch {
          // If git worktree remove fails, remove directory manually
          if (existsSync(wtPath)) {
            rmSync(wtPath, { recursive: true, force: true })
          }
        }
      } else if (existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true })
      }
    }

    // Remove task directory if requested (skip when session is still active)
    if (removeTaskDir) {
      const taskDir = join(WORKSPACES_DIR, taskId)
      if (existsSync(taskDir)) {
        try {
          rmSync(taskDir, { recursive: true, force: true })
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Collect the working-tree diff for each of a task's repo worktrees.
   * Returns one raw unified diff per repo — tracked changes vs HEAD plus
   * untracked files rendered via `git diff --no-index` (read-only; never
   * mutates the index). Repos without a worktree yet are skipped; per-repo
   * failures are reported rather than thrown so one bad repo can't hide the rest.
   */
  async getTaskChanges(
    taskId: string,
    repos: { fullName: string }[]
  ): Promise<Array<{ repo: string; diff: string; error?: string; noWorktree?: boolean; path?: string; branch?: string; pushed?: boolean; prNumber?: number; prUrl?: string; prState?: string }>> {
    const results: Array<{ repo: string; diff: string; error?: string; noWorktree?: boolean; path?: string; branch?: string; pushed?: boolean; prNumber?: number; prUrl?: string; prState?: string }> = []
    const gitOpts = { maxBuffer: 64 * 1024 * 1024 }

    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      const wtPath = this.worktreePath(taskId, repoName)
      if (!existsSync(wtPath)) {
        console.log(`[WorktreeManager] getTaskChanges: no worktree for ${repo.fullName} at ${wtPath}`)
        results.push({ repo: repo.fullName, diff: '', noWorktree: true, path: wtPath })
        continue
      }

      try {
        // Agents auto-commit, so "uncommitted only" (git diff HEAD) is usually
        // empty. We want the task's whole diff: base branch → current work
        // (committed + uncommitted). Discover the base branch this worktree
        // forked from, then diff against the merge-base.
        let baseRef = ''
        try {
          const { stdout } = await execFileAsync(
            'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
            { cwd: wtPath, ...gitOpts }
          )
          baseRef = stdout.trim() // e.g. "origin/main"
        } catch { /* origin/HEAD not set */ }
        if (!baseRef) {
          for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
            try {
              await execFileAsync('git', ['rev-parse', '--verify', '--quiet', cand], { cwd: wtPath, ...gitOpts })
              baseRef = cand
              break
            } catch { /* not this candidate */ }
          }
        }

        // Diff target: merge-base with the base branch (captures committed work);
        // fall back to HEAD (uncommitted only) if no base can be resolved.
        let against = 'HEAD'
        if (baseRef) {
          try {
            const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', baseRef], { cwd: wtPath, ...gitOpts })
            const mergeBase = stdout.trim()
            if (mergeBase) against = mergeBase
          } catch { /* keep HEAD */ }
        }

        // `git diff <against>` compares that commit to the WORKING TREE, so the
        // patch includes both committed and uncommitted changes.
        let tracked = ''
        try {
          const { stdout } = await execFileAsync(
            'git', ['-c', 'core.quotepath=false', 'diff', '--no-color', against],
            { cwd: wtPath, ...gitOpts }
          )
          tracked = stdout
        } catch (e) {
          const err = e as { stdout?: string }
          tracked = err.stdout ?? ''
        }

        // Untracked files → new-file patches (no index mutation).
        let untracked = ''
        try {
          const { stdout } = await execFileAsync(
            'git', ['ls-files', '--others', '--exclude-standard', '-z'],
            { cwd: wtPath, ...gitOpts }
          )
          for (const file of stdout.split('\0').filter(Boolean)) {
            try {
              await execFileAsync(
                'git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file],
                { cwd: wtPath, ...gitOpts }
              )
            } catch (e) {
              // --no-index exits 1 when files differ; the patch is on stdout.
              const err = e as { stdout?: string }
              if (err.stdout) untracked += err.stdout
            }
          }
        } catch {
          // Ignore untracked enumeration failures.
        }

        // Branch + PR metadata so the UI can group changes by branch / PR.
        let branch: string | undefined
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath, ...gitOpts })
          const b = stdout.trim()
          branch = b && b !== 'HEAD' ? b : undefined
        } catch { /* detached HEAD */ }

        let pushed = false
        if (branch) {
          try {
            await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: wtPath, ...gitOpts })
            pushed = true
          } catch { /* branch not on remote yet */ }
        }

        // Best-effort PR/MR lookup (only when the branch is pushed).
        let prNumber: number | undefined
        let prUrl: string | undefined
        let prState: string | undefined
        if (branch && pushed) {
          let provider: 'github' | 'gitlab' | 'other' = 'other'
          try {
            const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: wtPath, ...gitOpts })
            const url = stdout.toLowerCase()
            if (url.includes('gitlab')) provider = 'gitlab'
            else if (url.includes('github')) provider = 'github'
          } catch { /* ignore */ }

          try {
            if (provider === 'github') {
              const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'number,url,state'], { cwd: wtPath, timeout: 8000, ...gitOpts })
              const j = JSON.parse(stdout) as { number?: number; url?: string; state?: string }
              prNumber = j.number; prUrl = j.url; prState = j.state
            } else if (provider === 'gitlab') {
              const { stdout } = await execFileAsync('glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'], { cwd: wtPath, timeout: 8000, ...gitOpts })
              const arr = JSON.parse(stdout) as Array<{ iid?: number; web_url?: string; state?: string }>
              if (Array.isArray(arr) && arr[0]) { prNumber = arr[0].iid; prUrl = arr[0].web_url; prState = arr[0].state }
            }
          } catch { /* no PR/MR, or CLI unavailable */ }
        }

        results.push({ repo: repo.fullName, diff: tracked + untracked, branch, pushed, prNumber, prUrl, prState })
      } catch (e) {
        results.push({ repo: repo.fullName, diff: '', error: (e as Error).message })
      }
    }

    return results
  }
}
