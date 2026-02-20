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
    org: string
  ): Promise<string> {
    const taskDir = join(WORKSPACES_DIR, taskId)
    console.log(`[WorktreeManager] Setting up workspace for task ${taskId}`)
    console.log(`[WorktreeManager]   Task directory: ${taskDir}`)
    console.log(`[WorktreeManager]   Organization: ${org}`)
    console.log(`[WorktreeManager]   Repos to setup: ${repos.map(r => r.fullName).join(', ')}`)

    mkdirSync(taskDir, { recursive: true })

    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      try {
        console.log(`[WorktreeManager] Processing repo: ${repo.fullName}`)
        await this.ensureBareClone(org, repoName, repo.fullName)
        await this.fetchBareClone(org, repoName)
        await this.createWorktree(taskId, org, repoName, repo.defaultBranch)
        this.sendProgress(taskId, repoName, 'done', true)
      } catch (error: any) {
        console.error(`[WorktreeManager] Error setting up ${repo.fullName}:`, error.message)
        this.sendProgress(taskId, repoName, 'error', true, error.message)
        throw error
      }
    }

    console.log(`[WorktreeManager] Workspace setup complete: ${taskDir}`)
    return taskDir
  }

  private async ensureBareClone(org: string, repoName: string, fullName: string): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)

    if (existsSync(barePath)) {
      console.log(`[WorktreeManager]   Bare clone already exists: ${barePath}`)
      return
    }

    console.log(`[WorktreeManager]   Bare clone not found, creating: ${barePath}`)
    this.sendProgress('', repoName, 'cloning', false)
    const orgDir = join(REPOS_DIR, org)
    mkdirSync(orgDir, { recursive: true })

    console.log(`[WorktreeManager]   Executing: gh repo clone ${fullName} ${barePath} -- --bare`)
    await execFileAsync('gh', ['repo', 'clone', fullName, barePath, '--', '--bare'], {
      timeout: 300000
    })
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
    } catch (err: any) {
      console.error(`[WorktreeManager]   Fetch failed:`, err.message)
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
    } catch (err: any) {
      console.log(`[WorktreeManager]   Error checking for existing branch:`, err.message)
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
    } catch (err: any) {
      console.error(`[WorktreeManager]   Failed to create worktree:`, err.message)
      if (err.stdout) console.error(`[WorktreeManager]   stdout:`, err.stdout)
      if (err.stderr) console.error(`[WorktreeManager]   stderr:`, err.stderr)
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
}
