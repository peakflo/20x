import type { TaskRecord } from '../database'
import type { GitHubManager, GitHubIssue } from '../github-manager'
import type { SourceUser, ReassignResult } from '../../shared/types'
import { TaskStatus } from '../../shared/constants'
import type {
  TaskSourcePlugin,
  PluginConfigSchema,
  ConfigFieldOption,
  PluginContext,
  FieldMapping,
  PluginAction,
  PluginSyncResult,
  ActionResult
} from './types'

// Labels that map to priority (case-insensitive)
const PRIORITY_LABELS: Record<string, string> = {
  'p0': 'critical',
  'p1': 'high',
  'p2': 'medium',
  'p3': 'low',
  'critical': 'critical',
  'urgent': 'critical',
  'priority:critical': 'critical',
  'priority:high': 'high',
  'priority:medium': 'medium',
  'priority:low': 'low'
}

function isPriorityLabel(name: string): boolean {
  return name.toLowerCase() in PRIORITY_LABELS
}

export class GitHubIssuesPlugin implements TaskSourcePlugin {
  id = 'github-issues'
  displayName = 'GitHub Issues'
  description = 'Import and sync issues from a GitHub repository'
  icon = 'Github'
  requiresMcpServer = false

  constructor(private githubManager: GitHubManager) {}

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'owner',
        label: 'Owner',
        type: 'dynamic-select',
        optionsResolver: 'owners',
        required: true,
        description: 'GitHub user or organization'
      },
      {
        key: 'repo',
        label: 'Repository',
        type: 'dynamic-select',
        optionsResolver: 'repos',
        required: true,
        description: 'Repository to import issues from',
        dependsOn: { field: 'owner', value: undefined }
      },
      {
        key: 'state',
        label: 'Issue State',
        type: 'select',
        default: 'open',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
          { value: 'all', label: 'All' }
        ]
      },
      {
        key: 'assignee',
        label: 'Assignee Filter',
        type: 'text',
        placeholder: 'GitHub username (optional)',
        description: 'Only import issues assigned to this user'
      },
      {
        key: 'labels',
        label: 'Labels Filter',
        type: 'text',
        placeholder: 'bug, feature (optional)',
        description: 'Comma-separated labels to filter by'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    if (resolverKey === 'owners') {
      try {
        const status = await this.githubManager.checkGhCli()
        if (!status.authenticated) return []

        const orgs = await this.githubManager.fetchUserOrgs()
        const options: ConfigFieldOption[] = []

        if (status.username) {
          options.push({ value: status.username, label: `${status.username} (personal)` })
        }
        for (const org of orgs) {
          options.push({ value: org, label: org })
        }
        return options
      } catch {
        return []
      }
    }

    if (resolverKey === 'repos') {
      const owner = config.owner as string
      if (!owner) return []

      try {
        const status = await this.githubManager.checkGhCli()
        // Personal repos vs org repos
        const repos = owner === status.username
          ? await this.githubManager.fetchUserRepos()
          : await this.githubManager.fetchOrgRepos(owner)

        return repos.map((r) => ({ value: r.name, label: r.name }))
      } catch {
        return []
      }
    }

    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.owner || typeof config.owner !== 'string') return 'Owner is required'
    if (!config.repo || typeof config.repo !== 'string') return 'Repository is required'
    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'number',
      title: 'title',
      description: 'body',
      status: 'state',
      priority: 'labels',
      assignee: 'assignees[0].login',
      due_date: 'milestone.due_on',
      labels: 'labels'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: 'add_comment',
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      },
      {
        id: 'close_issue',
        label: 'Close Issue',
        icon: 'XCircle',
        variant: 'destructive'
      },
      {
        id: 'reopen_issue',
        label: 'Reopen Issue',
        icon: 'RotateCcw'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const owner = config.owner as string
    const repo = config.repo as string

    try {
      const issues = await this.githubManager.fetchIssues(owner, repo, {
        state: (config.state as string) || 'open',
        assignee: config.assignee as string | undefined,
        labels: config.labels as string | undefined
      })

      const fullRepoName = `${owner}/${repo}`

      for (const issue of issues) {
        try {
          const mapped = this.mapIssue(issue)
          const externalId = String(issue.number)
          const existing = ctx.db.getTaskByExternalId(sourceId, externalId)

          if (existing) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { status: _status, ...withoutStatus } = mapped
            ctx.db.updateTask(existing.id, withoutStatus)
            result.updated++
          } else {
            const created = ctx.db.createTask({
              ...mapped,
              title: mapped.title || issue.title,
              source_id: sourceId,
              external_id: externalId,
              source: 'GitHub',
              status: mapped.status || TaskStatus.NotStarted,
              repos: [fullRepoName]
            })
            if (created) result.imported++
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Failed to import #${issue.number} "${issue.title}": ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${msg}`)
    }

    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) return
    const owner = config.owner as string
    const repo = config.repo as string
    const number = parseInt(task.external_id, 10)

    const updates: { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] } = {}

    if (changedFields.title) updates.title = changedFields.title as string
    if (changedFields.description) updates.body = changedFields.description as string

    if (changedFields.status) {
      updates.state = this.mapStatusToGitHub(changedFields.status as string)
    }

    if (changedFields.assignee) {
      updates.assignees = [(changedFields.assignee as string)]
    }

    if (changedFields.labels) {
      updates.labels = changedFields.labels as string[]
    }

    if (Object.keys(updates).length > 0) {
      try {
        await this.githubManager.updateIssue(owner, repo, number, updates)
      } catch (err) {
        console.error('[github-issues] Export update failed:', err)
      }
    }
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ActionResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task has no external ID' }
    }

    const owner = config.owner as string
    const repo = config.repo as string
    const number = parseInt(task.external_id, 10)

    try {
      switch (actionId) {
        case 'add_comment':
          if (!input) return { success: false, error: 'Comment text is required' }
          await this.githubManager.addIssueComment(owner, repo, number, input)
          return { success: true }

        case 'close_issue':
          await this.githubManager.updateIssue(owner, repo, number, { state: 'closed' })
          return { success: true, taskUpdate: { status: TaskStatus.Completed } }

        case 'reopen_issue':
          await this.githubManager.updateIssue(owner, repo, number, { state: 'open' })
          return { success: true, taskUpdate: { status: TaskStatus.NotStarted } }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${msg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    const owner = config.owner as string
    const repo = config.repo as string

    try {
      const collaborators = await this.githubManager.fetchRepoCollaborators(owner, repo)
      return collaborators.map((c) => ({
        id: c.login,
        email: '',
        name: c.login
      }))
    } catch {
      return []
    }
  }

  async reassignTask(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ReassignResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task has no external ID' }
    }

    const owner = config.owner as string
    const repo = config.repo as string
    const number = parseInt(task.external_id, 10)

    try {
      await this.githubManager.updateIssue(owner, repo, number, { assignees: userIds })
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  // ── Mapping helpers ──────────────────────────────────────

  private mapIssue(issue: GitHubIssue): Partial<TaskRecord> {
    const labelNames = issue.labels.map((l) => l.name)
    return {
      title: issue.title,
      description: issue.body || '',
      status: this.mapStatusFromGitHub(issue.state, labelNames),
      priority: this.extractPriority(labelNames),
      assignee: issue.assignees[0]?.login || '',
      due_date: issue.milestone?.due_on?.split('T')[0] || null,
      labels: labelNames.filter((n) => !isPriorityLabel(n))
    }
  }

  private mapStatusFromGitHub(state: string, labels: string[]): TaskStatus {
    if (state === 'closed') return TaskStatus.Completed

    const lower = labels.map((l) => l.toLowerCase())
    if (lower.some((l) => l.includes('in progress') || l === 'wip')) return TaskStatus.AgentWorking
    if (lower.some((l) => l.includes('review'))) return TaskStatus.ReadyForReview

    return TaskStatus.NotStarted
  }

  private mapStatusToGitHub(localStatus: string): string {
    if (localStatus === TaskStatus.Completed) return 'closed'
    return 'open'
  }

  private extractPriority(labels: string[]): string {
    for (const label of labels) {
      const mapped = PRIORITY_LABELS[label.toLowerCase()]
      if (mapped) return mapped
    }
    return 'medium'
  }

  getSetupDocumentation(): string {
    return `# GitHub Issues Integration

## Overview

Import issues from any GitHub repository and keep them in sync. Changes made locally (status, title, assignees) are pushed back to GitHub automatically.

Uses the **GitHub CLI** (\`gh\`) for authentication — no API tokens or OAuth apps to configure.

## Prerequisites

- [GitHub CLI](https://cli.github.com) installed
- Authenticated via \`gh auth login\`

## Setup Steps

### 1. Install GitHub CLI

\`\`\`
brew install gh
\`\`\`

Or download from [cli.github.com](https://cli.github.com).

### 2. Authenticate

\`\`\`
gh auth login
\`\`\`

Follow the prompts to sign in with your GitHub account. If you've already authenticated for repo management, you're all set.

### 3. Configure the Source

1. Select the **owner** (your personal account or an organization)
2. Select the **repository**
3. Optionally filter by issue state, assignee, or labels

## Features

### Import & Sync
- Issues are imported as tasks with full field mapping
- Re-syncing updates existing tasks without creating duplicates
- Pull requests are automatically excluded

### Bidirectional Updates
- Marking a task **completed** closes the GitHub issue
- Changing title, description, or assignee syncs back to GitHub

### Actions
- **Add Comment** — post a comment on the issue
- **Close Issue** — close and mark as completed
- **Reopen Issue** — reopen a closed issue

## Field Mapping

| GitHub | Local Task |
|--------|------------|
| Issue number | External ID |
| Title | Title |
| Body | Description |
| State + labels | Status |
| Priority labels | Priority |
| First assignee | Assignee |
| Milestone due date | Due date |
| Labels | Labels |

## Label Conventions

### Priority Labels

GitHub has no built-in priority field. The integration recognizes these label names:

| Label | Maps to |
|-------|---------|
| \`p0\`, \`critical\`, \`urgent\`, \`priority:critical\` | Critical |
| \`p1\`, \`priority:high\` | High |
| \`p2\`, \`priority:medium\` | Medium |
| \`p3\`, \`priority:low\` | Low |

Priority labels are consumed during mapping and won't appear in the task's labels list.

### Status Labels

| Label | Maps to |
|-------|---------|
| \`in progress\`, \`wip\` | In Progress |
| \`review\` | Ready for Review |
| *(closed issue)* | Completed |
| *(open, no status label)* | Not Started |

## Troubleshooting

### "gh: command not found"
Install the GitHub CLI and ensure it's in your PATH. Run \`gh --version\` to verify.

### Authentication expired
Run \`gh auth status\` to check. If expired, run \`gh auth login\` again.

### Issues not importing
- Verify the repo exists and you have access: \`gh repo view owner/repo\`
- Check your filter settings — a narrow assignee or label filter may exclude issues
- Pull requests are filtered out automatically

### Sync creates duplicates
This shouldn't happen — issues are matched by their number. If it does, check that the task source wasn't deleted and re-created (which changes the source ID).
`
  }
}
