import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)

const BASE_DIR = join(homedir(), '.pf-desktop')
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
    mkdirSync(taskDir, { recursive: true })

    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      try {
        await this.ensureBareClone(org, repoName, repo.fullName)
        await this.fetchBareClone(org, repoName)
        await this.createWorktree(taskId, org, repoName, repo.defaultBranch)
        this.sendProgress(taskId, repoName, 'done', true)
      } catch (error: any) {
        this.sendProgress(taskId, repoName, 'error', true, error.message)
        throw error
      }
    }

    return taskDir
  }

  private async ensureBareClone(org: string, repoName: string, fullName: string): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)

    if (existsSync(barePath)) return

    this.sendProgress('', repoName, 'cloning', false)
    const orgDir = join(REPOS_DIR, org)
    mkdirSync(orgDir, { recursive: true })

    await execFileAsync('gh', ['repo', 'clone', fullName, barePath, '--', '--bare'], {
      timeout: 300000
    })
  }

  private async fetchBareClone(org: string, repoName: string): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)
    this.sendProgress('', repoName, 'fetching', false)

    await execFileAsync('git', ['fetch', 'origin'], {
      cwd: barePath,
      timeout: 120000
    })
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

    if (existsSync(wtPath)) return

    this.sendProgress(taskId, repoName, 'creating worktree', false)

    const branchName = `task/${taskId}`

    // Check if branch already exists
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', branchName], {
        cwd: barePath
      })
      if (stdout.trim()) {
        // Branch exists — create worktree from existing branch
        await execFileAsync('git', ['worktree', 'add', wtPath, branchName], {
          cwd: barePath
        })
        return
      }
    } catch {
      // ignore — fall through to create new branch
    }

    const startRef = await this.resolveStartRef(barePath, defaultBranch)

    // Create worktree with new branch from resolved ref
    await execFileAsync('git', [
      'worktree', 'add', wtPath, '-b', branchName, startRef
    ], {
      cwd: barePath,
      timeout: 60000
    })
  }

  async cleanupTaskWorkspace(
    taskId: string,
    repos: { fullName: string }[],
    org: string
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

    // Remove task directory if empty
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
