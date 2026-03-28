import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
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
import type { TaskRecord } from '../database'
import type { SourceUser, ReassignResult } from '../../shared/types'
import { TaskStatus } from '../../shared/constants'
import { replaceRemoteImageUrlsInTask } from './replace-image-urls'
import { normalizeUrlForComparison, buildNormalizedUrlSet } from './url-utils'
import {
  YouTrackClient,
  type YouTrackIssue,
  type YouTrackCustomField,
  type YouTrackCustomFieldValue,
  type YouTrackAttachment,
  type YouTrackIssueLink
} from './youtrack-client'

// ── Status mapping ───────────────────────────────────────────

const STATUS_TO_LOCAL: Record<string, TaskStatus> = {
  'open': TaskStatus.NotStarted,
  'submitted': TaskStatus.NotStarted,
  'to do': TaskStatus.NotStarted,
  'todo': TaskStatus.NotStarted,
  'backlog': TaskStatus.NotStarted,
  'new': TaskStatus.NotStarted,
  'registered': TaskStatus.NotStarted,
  'in progress': TaskStatus.AgentWorking,
  'active': TaskStatus.AgentWorking,
  'started': TaskStatus.AgentWorking,
  'in development': TaskStatus.AgentWorking,
  'developing': TaskStatus.AgentWorking,
  'in review': TaskStatus.ReadyForReview,
  'review': TaskStatus.ReadyForReview,
  'to verify': TaskStatus.ReadyForReview,
  'to be discussed': TaskStatus.ReadyForReview,
  'fixed': TaskStatus.Completed,
  'done': TaskStatus.Completed,
  'complete': TaskStatus.Completed,
  'completed': TaskStatus.Completed,
  'resolved': TaskStatus.Completed,
  'verified': TaskStatus.Completed,
  'closed': TaskStatus.Completed,
  "won't fix": TaskStatus.Completed,
  'duplicate': TaskStatus.Completed,
  'obsolete': TaskStatus.Completed,
  "can't reproduce": TaskStatus.Completed
}

// ── Priority mapping ─────────────────────────────────────────

const PRIORITY_TO_LOCAL: Record<string, string> = {
  'show-stopper': 'critical',
  'critical': 'critical',
  'major': 'high',
  'normal': 'medium',
  'minor': 'low'
}

// ── Custom field type IDs ────────────────────────────────────
// YouTrack uses fieldType.id to identify field types programmatically

const STATE_FIELD_TYPE = 'state[1]'
const PRIORITY_FIELD_TYPE = 'ownedField[1]' // Priority bundle
const ENUM_FIELD_TYPE = 'enum[1]' // Type, etc.
// const USER_FIELD_TYPE = 'user[1]' // Reserved for future use

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract a custom field value by field name from a YouTrack issue.
 * YouTrack stores most fields (State, Priority, Assignee, Type) in customFields.
 */
function getCustomField(
  issue: YouTrackIssue,
  fieldName: string
): YouTrackCustomField | undefined {
  return issue.customFields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase()
  )
}

/**
 * Extract the display name from a custom field value.
 * Handles single-value and array-value fields.
 */
function getCustomFieldValueName(field: YouTrackCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined) return null

  // Single object value (State, Priority, Type, etc.)
  if (typeof field.value === 'object' && !Array.isArray(field.value)) {
    const val = field.value as YouTrackCustomFieldValue
    return val.name || val.presentation || null
  }

  // String or number value
  if (typeof field.value === 'string') return field.value
  if (typeof field.value === 'number') return String(field.value)

  return null
}

/**
 * Extract assignee name from a custom field.
 * Handles both single-user and multi-user Assignee fields.
 */
function getAssigneeName(field: YouTrackCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined) return null

  // Single user value
  if (typeof field.value === 'object' && !Array.isArray(field.value)) {
    const val = field.value as YouTrackCustomFieldValue
    return val.fullName || val.login || val.name || null
  }

  // Array of users (multi-value Assignee)
  if (Array.isArray(field.value) && field.value.length > 0) {
    const first = field.value[0] as YouTrackCustomFieldValue
    return first.fullName || first.login || first.name || null
  }

  return null
}

/**
 * Find a custom field by its fieldType.id rather than name.
 * Useful when field names vary across projects.
 */
function getCustomFieldByType(
  issue: YouTrackIssue,
  fieldTypeId: string
): YouTrackCustomField | undefined {
  return issue.customFields.find(
    (f) => f.projectCustomField?.field?.fieldType?.id === fieldTypeId
  )
}

/**
 * Detect MIME type from file content magic bytes.
 */
function detectMimeTypeFromContent(buffer: Buffer): string | null {
  if (buffer.length < 4) return null

  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }
  // PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf'
  }
  // ZIP (also docx, xlsx, etc.)
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return 'application/zip'
  }

  return null
}

// ── Plugin ───────────────────────────────────────────────────

export class YouTrackPlugin implements TaskSourcePlugin {
  id = 'youtrack'
  displayName = 'YouTrack'
  description = 'Import tasks from a YouTrack project'
  icon = 'Bug'
  requiresMcpServer = false

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'server_url',
        label: 'Server URL',
        type: 'text',
        required: true,
        placeholder: 'https://youtrack.your-company.com',
        description:
          'Your YouTrack instance URL (cloud or self-hosted)'
      },
      {
        key: 'api_token',
        label: 'Permanent Token',
        type: 'password',
        required: true,
        placeholder: 'perm:...',
        description:
          'Bottom-left profile icon → Profile → Account Security → New Token (scope: YouTrack). See https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html'
      },
      {
        key: 'project',
        label: 'Project',
        type: 'dynamic-select',
        optionsResolver: 'projects',
        required: true,
        dependsOn: { field: 'api_token', value: '__any__' }
      },
      {
        key: 'assignee',
        label: 'Assignee',
        type: 'dynamic-select',
        optionsResolver: 'users',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'state',
        label: 'State',
        type: 'dynamic-select',
        optionsResolver: 'states',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'dynamic-select',
        optionsResolver: 'priorities',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'issue_type',
        label: 'Type',
        type: 'dynamic-select',
        optionsResolver: 'types',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'custom_query',
        label: 'Additional Query (YQL)',
        type: 'text',
        placeholder: '#Unresolved sort by: updated desc',
        description:
          'Optional YouTrack search query appended to filters above'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    const serverUrl = config.server_url as string
    const token = config.api_token as string
    if (!serverUrl || !token) return []

    const client = new YouTrackClient(serverUrl, token)

    if (resolverKey === 'projects') {
      try {
        const projects = await client.getProjects()
        return projects.map((p) => ({
          value: p.shortName,
          label: `${p.name} (${p.shortName})`
        }))
      } catch (err) {
        console.error('[youtrack] Failed to fetch projects:', err)
        return []
      }
    }

    if (resolverKey === 'users') {
      try {
        const users = await client.getUsers()
        return users.map((u) => ({
          value: u.login,
          label: u.fullName || u.login
        }))
      } catch (err) {
        console.error('[youtrack] Failed to fetch users:', err)
        return []
      }
    }

    // For states, priorities, and types — resolve from project custom fields
    if (
      resolverKey === 'states' ||
      resolverKey === 'priorities' ||
      resolverKey === 'types'
    ) {
      const projectShortName = config.project as string
      if (!projectShortName) return []

      try {
        // First get the project ID from short name
        const projects = await client.getProjects()
        const project = projects.find((p) => p.shortName === projectShortName)
        if (!project) return []

        const customFields = await client.getProjectCustomFields(project.id)

        let targetFieldTypeId: string
        let fallbackFieldName: string
        if (resolverKey === 'states') {
          targetFieldTypeId = STATE_FIELD_TYPE
          fallbackFieldName = 'state'
        } else if (resolverKey === 'priorities') {
          targetFieldTypeId = PRIORITY_FIELD_TYPE
          fallbackFieldName = 'priority'
        } else {
          targetFieldTypeId = ENUM_FIELD_TYPE
          fallbackFieldName = 'type'
        }

        // Find field by type ID first, then by name as fallback
        let field = customFields.find(
          (f) => f.field.fieldType.id === targetFieldTypeId
        )
        if (!field) {
          field = customFields.find(
            (f) =>
              f.field.name.toLowerCase() === fallbackFieldName
          )
        }

        if (!field?.bundle?.values) return []

        return field.bundle.values.map((v) => ({
          value: v.name,
          label: v.name
        }))
      } catch (err) {
        console.error(
          `[youtrack] Failed to fetch ${resolverKey}:`,
          err
        )
        return []
      }
    }

    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.server_url || typeof config.server_url !== 'string') {
      return 'Server URL is required'
    }
    if (!config.api_token || typeof config.api_token !== 'string') {
      return 'Permanent token is required'
    }
    if (!config.project || typeof config.project !== 'string') {
      return 'Project is required'
    }
    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'id',
      title: 'summary',
      description: 'description',
      status: 'State',
      priority: 'Priority',
      assignee: 'Assignee',
      labels: 'tags'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: 'open_in_youtrack',
        label: 'Open in YouTrack',
        icon: 'ExternalLink'
      },
      {
        id: 'add_comment',
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      },
      {
        id: 'change_state',
        label: 'Change State',
        icon: 'ArrowRightCircle',
        requiresInput: true,
        inputLabel: 'New State',
        inputPlaceholder: 'e.g. In Progress, Fixed, Done'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const serverUrl = config.server_url as string
    const token = config.api_token as string

    const client = new YouTrackClient(serverUrl, token)

    try {
      // Determine if this is an incremental sync.
      // Only use incremental sync if we have previously imported tasks from this source.
      const source = ctx.db.getTaskSource(sourceId)
      const existingTasks = ctx.db.getTasks().filter(t => t.source_id === sourceId)
      const isIncremental = existingTasks.length > 0 && !!source?.last_synced_at

      // For full sync: use all configured filters.
      // For incremental sync: use a relaxed query (project + updated only) so we
      // catch issues whose state/assignee/priority changed since last sync. We still
      // need to update already-tracked issues even if they no longer match the filters.
      const yql = isIncremental
        ? this.buildIncrementalYqlQuery(config, source!.last_synced_at!)
        : this.buildYqlQuery(config, null)
      console.log('[youtrack] YQL query:', yql, isIncremental ? '(incremental)' : '(full)')

      // Fetch all matching issues
      const issues = await client.getAllIssues(yql)

      for (const issue of issues) {
        try {
          const mapped = this.mapIssue(issue)
          if (!mapped.title) continue

          // Build description with issue details
          const description = this.buildDescription(issue, client.getBaseUrl())

          const existing = ctx.db.getTaskByExternalId(sourceId, issue.id)

          if (existing) {
            // Always update already-tracked issues (even if filters changed)
            ctx.db.updateTask(existing.id, {
              title: mapped.title,
              description: description || existing.description,
              status: mapped.status,
              priority: mapped.priority,
              assignee: mapped.assignee,
              labels: mapped.labels
            })
            result.updated++

            // Download attachments
            if (issue.attachments && issue.attachments.length > 0) {
              await this.downloadYouTrackAttachments(
                existing.id,
                issue.attachments,
                client,
                ctx
              )
            }
            replaceRemoteImageUrlsInTask(existing.id, ctx, '[youtrack]')
          } else if (isIncremental && !this.issueMatchesFilters(issue, config)) {
            // Incremental sync fetched this issue because it was updated, but it
            // doesn't match the user's configured filters — skip creating it.
            continue
          } else {
            const created = ctx.db.createTask({
              title: mapped.title,
              description,
              type: mapped.type || 'general',
              priority: mapped.priority || 'medium',
              status: mapped.status || TaskStatus.NotStarted,
              assignee: mapped.assignee,
              labels: mapped.labels,
              external_id: issue.id,
              source_id: sourceId,
              source: 'YouTrack'
            })
            if (!created) {
              console.error(
                '[youtrack] Failed to create task for issue:',
                issue.idReadable
              )
              continue
            }
            result.imported++

            // Download attachments
            if (issue.attachments && issue.attachments.length > 0) {
              console.log(
                `[youtrack] Found ${issue.attachments.length} attachments for issue "${issue.idReadable}"`
              )
              await this.downloadYouTrackAttachments(
                created.id,
                issue.attachments,
                client,
                ctx
              )
            }
            replaceRemoteImageUrlsInTask(created.id, ctx, '[youtrack]')
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Issue ${issue.idReadable}: ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${msg}`)
    }

    ctx.db.updateTaskSourceLastSynced(sourceId)
    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) return

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    try {
      const updates: Record<string, unknown> = {}

      if (changedFields.title && typeof changedFields.title === 'string') {
        updates.summary = changedFields.title
      }

      if (changedFields.description && typeof changedFields.description === 'string') {
        updates.description = changedFields.description
      }

      // For custom field updates, we need to use a different approach
      const customFieldUpdates: Array<{ name: string; value: unknown }> = []

      if (changedFields.status) {
        const stateValue = this.localStatusToYouTrack(
          changedFields.status as string
        )
        if (stateValue) {
          customFieldUpdates.push({
            name: 'State',
            value: { name: stateValue }
          })
        }
      }

      if (changedFields.priority) {
        const priorityValue = this.localPriorityToYouTrack(
          changedFields.priority as string
        )
        if (priorityValue) {
          customFieldUpdates.push({
            name: 'Priority',
            value: { name: priorityValue }
          })
        }
      }

      if (customFieldUpdates.length > 0) {
        updates.customFields = customFieldUpdates
      }

      if (Object.keys(updates).length > 0) {
        await client.updateIssue(task.external_id, updates)
      }
    } catch (err) {
      console.error('[youtrack] Export update failed:', err)
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

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    if (actionId === 'open_in_youtrack') {
      // Fetch the issue to get the readable ID for URL construction
      try {
        const issue = await client.getIssue(task.external_id)
        const url = `${client.getBaseUrl()}/issue/${issue.idReadable}`
        return {
          success: true,
          taskUpdate: { _openUrl: url }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to get issue URL: ${msg}` }
      }
    }

    if (actionId === 'add_comment') {
      if (!input) {
        return { success: false, error: 'Comment text is required' }
      }
      try {
        await client.addComment(task.external_id, input)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to add comment: ${msg}` }
      }
    }

    if (actionId === 'change_state') {
      if (!input) {
        return { success: false, error: 'State value is required' }
      }
      try {
        await client.updateIssue(task.external_id, {
          customFields: [{ name: 'State', value: { name: input } }]
        })

        // Map back to local status
        const taskUpdate: Record<string, unknown> = {}
        const localStatus = STATUS_TO_LOCAL[input.toLowerCase()]
        if (localStatus) taskUpdate.status = localStatus

        return {
          success: true,
          taskUpdate:
            Object.keys(taskUpdate).length > 0 ? taskUpdate : undefined
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to change state: ${msg}` }
      }
    }

    return { success: false, error: `Unknown action: ${actionId}` }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    const serverUrl = config.server_url as string
    const token = config.api_token as string
    if (!serverUrl || !token) return []

    try {
      const client = new YouTrackClient(serverUrl, token)
      const users = await client.getUsers()
      return users.map((u) => ({
        id: u.login,
        email: u.email || '',
        name: u.fullName || u.login
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

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    try {
      // YouTrack typically has a single Assignee field
      const login = userIds[0]
      if (!login) {
        return { success: false, error: 'No user specified' }
      }

      await client.updateIssue(task.external_id, {
        customFields: [
          { name: 'Assignee', value: { login } }
        ]
      })

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  getSetupDocumentation(): string {
    return `# YouTrack Integration Setup

## Overview

Import tasks from a YouTrack project. Supports filtering by state, priority, assignee, type, and custom YQL queries. Works with both YouTrack Cloud and self-hosted instances.

## Prerequisites

- A YouTrack instance (Cloud or self-hosted)
- A permanent token with YouTrack scope

## Setup Steps

### 1. Generate a Permanent Token

See [JetBrains documentation](https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html) for full details.

1. Open YouTrack and click the **profile icon** (bottom-left)
2. Go to **Profile** > **Account Security**
3. Under **Tokens**, click **New token...**
4. Enter a **Token name** (e.g. "20x Integration")
5. Under **Scope**, select **YouTrack**
6. Click **Create**
7. **Copy the token immediately** -- it won't be shown again

### 2. Configure the Source

1. Enter your **Server URL** (e.g. \`https://youtrack.your-company.com\` or \`https://your-org.youtrack.cloud\`)
2. Paste your **Permanent Token**
3. Select the **Project** from the dropdown
4. Optionally filter by **Assignee**, **State**, **Priority**, or **Type**
5. Optionally add a raw **YQL query** for advanced filtering
6. Click **Save** and **Sync**

## Features

### Smart Filtering
Select filter values for state, priority, assignee, and type. Multiple values for the same field are combined with OR. All field filters and the optional custom YQL query are combined with AND.

### YouTrack Query Language (YQL)
Use the **Additional Query** field to add any valid YQL expression:
- \`#Unresolved\` -- only unresolved issues
- \`sort by: updated desc\` -- sort by last updated
- \`created: {Last week}\` -- issues created in the last week
- \`tag: important\` -- issues with a specific tag

### Incremental Sync
After the first full sync, subsequent syncs only fetch issues updated since the last sync.

### Bidirectional Updates
Changes to title, state, and priority sync back to YouTrack.

### Attachments
File attachments on YouTrack issues are downloaded and stored locally.

## Troubleshooting

### "Authentication failed"
- Verify your permanent token is correct
- Tokens can be revoked -- check Account Security in your profile

### "Access forbidden"
- Your token may lack the YouTrack scope
- You may not have access to the selected project

### No projects appear
- Check that your YouTrack URL is correct and reachable
- Some self-hosted instances restrict admin API access -- contact your admin

### Self-hosted instances
- Use the full URL including any path prefix (e.g. \`https://server.com/youtrack\`)
- The instance must be reachable from your machine (VPN/LAN)
`
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Build a YQL query string from the config filters.
   * Combines project, assignee, state, priority, type, and custom query.
   */
  private buildYqlQuery(
    config: Record<string, unknown>,
    _lastSyncedAt?: string | null
  ): string {
    const parts: string[] = []

    // Project filter (always required)
    const project = config.project as string
    if (project) {
      parts.push(`project: {${project}}`)
    }

    // Assignee filter — wrap each value in braces for names with spaces
    const assignees = config.assignee as string[] | string | undefined
    if (assignees) {
      const assigneeList = Array.isArray(assignees) ? assignees : [assignees]
      if (assigneeList.length > 0) {
        const assigneeValues = assigneeList.map((a) => `{${a}}`).join(', ')
        parts.push(`for: ${assigneeValues}`)
      }
    }

    // State filter
    const states = config.state as string[] | string | undefined
    if (states) {
      const stateList = Array.isArray(states) ? states : [states]
      if (stateList.length > 0) {
        // YQL: State: {value1}, {value2} uses OR logic
        const stateValues = stateList.map((s) => `{${s}}`).join(', ')
        parts.push(`State: ${stateValues}`)
      }
    }

    // Priority filter
    const priorities = config.priority as string[] | string | undefined
    if (priorities) {
      const priorityList = Array.isArray(priorities)
        ? priorities
        : [priorities]
      if (priorityList.length > 0) {
        const priorityValues = priorityList.map((p) => `{${p}}`).join(', ')
        parts.push(`Priority: ${priorityValues}`)
      }
    }

    // Type filter
    const types = config.issue_type as string[] | string | undefined
    if (types) {
      const typeList = Array.isArray(types) ? types : [types]
      if (typeList.length > 0) {
        const typeValues = typeList.map((t) => `{${t}}`).join(', ')
        parts.push(`Type: ${typeValues}`)
      }
    }

    // Custom YQL query (appended as-is)
    const customQuery = config.custom_query as string | undefined
    if (customQuery && customQuery.trim()) {
      parts.push(customQuery.trim())
    }

    return parts.join(' ')
  }

  /**
   * Build a relaxed YQL query for incremental sync.
   * Only uses project + updated filter so we catch issues whose state/assignee/priority
   * changed since last sync. New issues are filtered locally via issueMatchesFilters().
   */
  private buildIncrementalYqlQuery(
    config: Record<string, unknown>,
    lastSyncedAt: string
  ): string {
    const parts: string[] = []

    const project = config.project as string
    if (project) {
      parts.push(`project: {${project}}`)
    }

    // Convert ISO date to YouTrack date format (YYYY-MM-DDTHH:MM)
    const syncDate = new Date(lastSyncedAt)
    const formatted = `${syncDate.getFullYear()}-${String(syncDate.getMonth() + 1).padStart(2, '0')}-${String(syncDate.getDate()).padStart(2, '0')}T${String(syncDate.getHours()).padStart(2, '0')}:${String(syncDate.getMinutes()).padStart(2, '0')}`
    parts.push(`updated: ${formatted} .. *`)

    // Custom YQL query (appended as-is)
    const customQuery = config.custom_query as string | undefined
    if (customQuery && customQuery.trim()) {
      parts.push(customQuery.trim())
    }

    return parts.join(' ')
  }

  /**
   * Check if a YouTrack issue matches the user's configured filters.
   * Used during incremental sync to decide whether to create new tasks
   * for issues that weren't previously tracked.
   */
  private issueMatchesFilters(
    issue: YouTrackIssue,
    config: Record<string, unknown>
  ): boolean {
    // Assignee filter
    const assignees = config.assignee as string[] | string | undefined
    if (assignees) {
      const assigneeList = Array.isArray(assignees) ? assignees : [assignees]
      if (assigneeList.length > 0) {
        const assigneeField =
          getCustomField(issue, 'Assignee') ||
          getCustomFieldByType(issue, 'jetbrains.charisma.customfields.complex.user.SingleUserIssueCustomField')
        const assigneeName = getCustomFieldValueName(assigneeField)
        const assigneeLogin = assigneeField?.value &&
          typeof assigneeField.value === 'object' &&
          !Array.isArray(assigneeField.value)
          ? (assigneeField.value as { login?: string }).login
          : undefined
        if (!assigneeList.some((a) => a === assigneeName || a === assigneeLogin)) {
          return false
        }
      }
    }

    // State filter
    const states = config.state as string[] | string | undefined
    if (states) {
      const stateList = Array.isArray(states) ? states : [states]
      if (stateList.length > 0) {
        const stateField =
          getCustomField(issue, 'State') ||
          getCustomFieldByType(issue, STATE_FIELD_TYPE)
        const stateName = getCustomFieldValueName(stateField)
        if (!stateName || !stateList.includes(stateName)) {
          return false
        }
      }
    }

    // Priority filter
    const priorities = config.priority as string[] | string | undefined
    if (priorities) {
      const priorityList = Array.isArray(priorities) ? priorities : [priorities]
      if (priorityList.length > 0) {
        const priorityField =
          getCustomField(issue, 'Priority') ||
          getCustomFieldByType(issue, PRIORITY_FIELD_TYPE)
        const priorityName = getCustomFieldValueName(priorityField)
        if (!priorityName || !priorityList.includes(priorityName)) {
          return false
        }
      }
    }

    // Type filter
    const types = config.issue_type as string[] | string | undefined
    if (types) {
      const typeList = Array.isArray(types) ? types : [types]
      if (typeList.length > 0) {
        const typeField =
          getCustomField(issue, 'Type') ||
          getCustomFieldByType(issue, ENUM_FIELD_TYPE)
        const typeName = getCustomFieldValueName(typeField)
        if (!typeName || !typeList.includes(typeName)) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Map a YouTrack issue to local task fields.
   */
  private mapIssue(issue: YouTrackIssue): {
    title: string
    status?: string
    priority?: string
    assignee?: string
    labels?: string[]
    type?: string
  } {
    const title = issue.summary || ''

    // State -> status
    let status: string | undefined
    const stateField =
      getCustomField(issue, 'State') ||
      getCustomFieldByType(issue, STATE_FIELD_TYPE)
    const rawState = getCustomFieldValueName(stateField)
    if (rawState) {
      status = STATUS_TO_LOCAL[rawState.toLowerCase()] || TaskStatus.NotStarted
    }

    // Priority
    let priority: string | undefined
    const priorityField =
      getCustomField(issue, 'Priority') ||
      getCustomFieldByType(issue, PRIORITY_FIELD_TYPE)
    const rawPriority = getCustomFieldValueName(priorityField)
    if (rawPriority) {
      priority = PRIORITY_TO_LOCAL[rawPriority.toLowerCase()] || 'medium'
    }

    // Assignee
    const assigneeField = getCustomField(issue, 'Assignee')
    const assignee: string | undefined = getAssigneeName(assigneeField) || undefined

    // Labels from tags
    let labels: string[] | undefined
    if (issue.tags && issue.tags.length > 0) {
      labels = issue.tags.map((t) => t.name)
    }

    // Type — map YouTrack issue types to local task types
    let type: string | undefined
    const typeField = getCustomField(issue, 'Type')
    const rawType = getCustomFieldValueName(typeField)
    if (rawType) {
      const TYPE_TO_LOCAL: Record<string, string> = {
        'bug': 'coding',
        'feature': 'coding',
        'task': 'general',
        'cosmetics': 'coding',
        'exception': 'coding',
        'usability problem': 'review',
        'performance problem': 'coding',
        'epic': 'general',
        'story': 'general'
      }
      type = TYPE_TO_LOCAL[rawType.toLowerCase()] || 'general'
    }

    return { title, status, priority, assignee, labels, type }
  }

  /**
   * Build a markdown description from a YouTrack issue.
   * Includes the issue description, custom fields table, and link.
   */
  private buildDescription(
    issue: YouTrackIssue,
    baseUrl: string
  ): string {
    const parts: string[] = []

    // Issue description (may be null)
    if (issue.description) {
      parts.push(issue.description)
    }

    // Custom fields table
    const fieldsSection = this.formatCustomFields(issue)
    if (fieldsSection) {
      parts.push(fieldsSection)
    }

    // Linked issues with deep links
    const linksSection = this.formatLinkedIssues(issue, baseUrl)
    if (linksSection) {
      parts.push(linksSection)
    }

    // Link to YouTrack issue
    const issueUrl = `${baseUrl}/issue/${issue.idReadable}`
    parts.push('')
    parts.push(`[View in YouTrack](${issueUrl})`)

    return parts.join('\n\n')
  }

  /**
   * Format linked issues as a markdown section with deep links.
   * Groups links by relationship type (e.g. "Depends on", "Subtask of", "Relates to").
   */
  private formatLinkedIssues(
    issue: YouTrackIssue,
    baseUrl: string
  ): string | null {
    // Collect all link entries grouped by relationship label
    const grouped: Record<string, Array<{ id: string; summary: string; resolved: boolean }>> = {}

    const addLink = (label: string, linked: { idReadable: string; summary: string; resolved: number | null }) => {
      const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1)
      if (!grouped[capitalizedLabel]) grouped[capitalizedLabel] = []
      grouped[capitalizedLabel].push({
        id: linked.idReadable,
        summary: linked.summary,
        resolved: linked.resolved != null
      })
    }

    const processIssueLink = (link: YouTrackIssueLink) => {
      if (!link.linkType || !link.issues || link.issues.length === 0) return

      // Determine the relationship label based on direction
      let label: string
      if (link.direction === 'OUTWARD') {
        label = link.linkType.sourceToTarget || link.linkType.name
      } else if (link.direction === 'INWARD') {
        label = link.linkType.targetToSource || link.linkType.name
      } else {
        label = link.linkType.name
      }

      for (const linked of link.issues) {
        addLink(label, linked)
      }
    }

    // Process parent (dedicated field — separate from links array)
    if (issue.parent?.issues && issue.parent.issues.length > 0) {
      const parentLabel = issue.parent.linkType?.targetToSource || 'Subtask of'
      for (const linked of issue.parent.issues) {
        addLink(parentLabel, linked)
      }
    }

    // Process subtasks (dedicated field — separate from links array)
    if (issue.subtasks?.issues && issue.subtasks.issues.length > 0) {
      const subtaskLabel = issue.subtasks.linkType?.sourceToTarget || 'Parent for'
      for (const linked of issue.subtasks.issues) {
        addLink(subtaskLabel, linked)
      }
    }

    // Process general links
    if (issue.links) {
      for (const link of issue.links) {
        processIssueLink(link)
      }
    }

    const labels = Object.keys(grouped)
    if (labels.length === 0) return null

    const lines: string[] = ['### Linked Issues', '']

    for (const label of labels) {
      for (const item of grouped[label]) {
        const issueUrl = `${baseUrl}/issue/${item.id}`
        const strikethrough = item.resolved ? '~~' : ''
        lines.push(`- **${label}**: ${strikethrough}[${item.id}](${issueUrl}) — ${item.summary}${strikethrough}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Format custom fields as a markdown properties table.
   */
  private formatCustomFields(issue: YouTrackIssue): string {
    const lines: string[] = []

    // Add project info
    if (issue.project) {
      lines.push(
        `| Project | ${issue.project.name} (${issue.project.shortName}) |`
      )
    }

    // Add issue ID
    lines.push(`| ID | ${issue.idReadable} |`)

    // Add custom fields
    for (const field of issue.customFields) {
      const value = this.formatCustomFieldValue(field)
      if (value) {
        lines.push(`| ${field.name} | ${value} |`)
      }
    }

    // Add tags
    if (issue.tags && issue.tags.length > 0) {
      const tagNames = issue.tags.map((t) => t.name).join(', ')
      lines.push(`| Tags | ${tagNames} |`)
    }

    if (lines.length === 0) return ''

    return (
      '---\n\n**Properties**\n\n| Property | Value |\n| --- | --- |\n' +
      lines.join('\n')
    )
  }

  /**
   * Format a single custom field value as a string.
   */
  private formatCustomFieldValue(field: YouTrackCustomField): string | null {
    if (field.value === null || field.value === undefined) return null

    // Single object value
    if (typeof field.value === 'object' && !Array.isArray(field.value)) {
      const val = field.value as YouTrackCustomFieldValue
      return (
        val.fullName || val.name || val.login || val.presentation || val.text || null
      )
    }

    // Array value (multi-select, multi-user)
    if (Array.isArray(field.value)) {
      if (field.value.length === 0) return null
      return field.value
        .map((v: YouTrackCustomFieldValue) =>
          v.fullName || v.name || v.login || v.presentation || v.text || ''
        )
        .filter(Boolean)
        .join(', ')
    }

    // String or number
    if (typeof field.value === 'string') return field.value || null
    if (typeof field.value === 'number') return String(field.value)

    return null
  }

  /**
   * Map a local 20x status back to a YouTrack State name.
   */
  private localStatusToYouTrack(localStatus: string): string | null {
    const mapping: Record<string, string> = {
      [TaskStatus.NotStarted]: 'Open',
      [TaskStatus.AgentWorking]: 'In Progress',
      [TaskStatus.ReadyForReview]: 'In Review',
      [TaskStatus.Completed]: 'Fixed'
    }
    return mapping[localStatus] || null
  }

  /**
   * Map a local 20x priority back to a YouTrack Priority name.
   */
  private localPriorityToYouTrack(localPriority: string): string | null {
    const mapping: Record<string, string> = {
      critical: 'Critical',
      high: 'Major',
      medium: 'Normal',
      low: 'Minor'
    }
    return mapping[localPriority] || null
  }

  /**
   * Download YouTrack attachments and save them as task attachments.
   * Skips files that have already been downloaded (by URL).
   */
  private async downloadYouTrackAttachments(
    taskId: string,
    attachments: YouTrackAttachment[],
    client: YouTrackClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    // Check for already-downloaded attachments (dedup by URL)
    const existingUrls = buildNormalizedUrlSet(
      (task.attachments || []) as unknown as Array<Record<string, unknown>>,
      'youtrack_url'
    )

    const attachmentsDir = ctx.db.getAttachmentsDir(taskId)

    for (const att of attachments) {
      try {
        const attUrl = att.url.startsWith('http')
          ? att.url
          : `${client.getBaseUrl()}${att.url}`
        const normalizedUrl = normalizeUrlForComparison(attUrl)

        if (existingUrls.has(normalizedUrl)) {
          continue // Already downloaded
        }

        const { buffer, filename, contentType } =
          await client.downloadAttachment(att.url)

        // Detect MIME type: prefer API-reported, then magic bytes, then response header
        let mimeType = att.mimeType || contentType
        const detectedMime = detectMimeTypeFromContent(buffer)
        if (detectedMime) {
          mimeType = detectedMime
        }

        const attachmentId = randomUUID()
        const safeFilename = att.name || filename
        const filePath = join(attachmentsDir, `${attachmentId}-${safeFilename}`)
        writeFileSync(filePath, buffer)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newAttachment: any = {
          id: attachmentId,
          filename: safeFilename,
          size: buffer.length,
          mime_type: mimeType,
          added_at: new Date().toISOString(),
          youtrack_url: attUrl // For deduplication
        }

        // Re-read task to get latest attachments (may have been updated)
        const currentTask = ctx.db.getTask(taskId)
        const currentAttachments = currentTask?.attachments || []
        ctx.db.updateTask(taskId, {
          attachments: [...currentAttachments, newAttachment]
        })
      } catch (err) {
        console.error(
          `[youtrack] Failed to download attachment "${att.name}":`,
          err
        )
      }
    }
  }
}
