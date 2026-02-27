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
import {
  NotionClient,
  type NotionDatabase,
  type NotionPage,
  type NotionPropertySchema,
  type NotionPropertyValue,
  type NotionFilter
} from './notion-client'

// ── Notion property types ────────────────────────────────────

export enum NotionPropertyType {
  Title = 'title',
  RichText = 'rich_text',
  Number = 'number',
  Select = 'select',
  MultiSelect = 'multi_select',
  Status = 'status',
  Date = 'date',
  People = 'people',
  Checkbox = 'checkbox',
  Url = 'url',
  Email = 'email',
  PhoneNumber = 'phone_number',
  Files = 'files',
  CreatedTime = 'created_time',
  LastEditedTime = 'last_edited_time',
  Formula = 'formula',
  Relation = 'relation',
  Rollup = 'rollup'
}

/** Property types that support server-side filtering */
export const FILTERABLE_PROPERTY_TYPES = new Set([
  NotionPropertyType.Status,
  NotionPropertyType.Select,
  NotionPropertyType.MultiSelect,
  NotionPropertyType.People,
  NotionPropertyType.Title,
  NotionPropertyType.RichText,
  NotionPropertyType.Number,
  NotionPropertyType.Checkbox,
  NotionPropertyType.Date
])

/** Property types that have predefined option values (rendered as dropdown/checkboxes in UI) */
export const ENUM_PROPERTY_TYPES = new Set([
  NotionPropertyType.Status,
  NotionPropertyType.Select,
  NotionPropertyType.MultiSelect,
  NotionPropertyType.People
])

/** Human-readable labels for property types */
export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  [NotionPropertyType.Status]: 'Status',
  [NotionPropertyType.Select]: 'Select',
  [NotionPropertyType.MultiSelect]: 'Multi-select',
  [NotionPropertyType.Title]: 'Title',
  [NotionPropertyType.RichText]: 'Text',
  [NotionPropertyType.Number]: 'Number',
  [NotionPropertyType.Checkbox]: 'Checkbox',
  [NotionPropertyType.Date]: 'Date',
  [NotionPropertyType.People]: 'People',
  [NotionPropertyType.Url]: 'URL',
  [NotionPropertyType.Email]: 'Email'
}

// ── Filter config (stored in source config) ──────────────────

export interface NotionFilterConfig {
  property: string
  type: string
  values: string[]
}

/**
 * Maps a Notion property type to its Notion API filter key and operator.
 * Returns { filterKey, operator } for building Notion compound filters.
 */
function buildPropertyFilter(
  type: string,
  property: string,
  val: string
): Record<string, unknown> {
  switch (type) {
    case NotionPropertyType.Status:
      return { property, status: { equals: val } }
    case NotionPropertyType.Select:
      return { property, select: { equals: val } }
    case NotionPropertyType.MultiSelect:
      return { property, multi_select: { contains: val } }
    case NotionPropertyType.People:
      return { property, people: { contains: val } }
    case NotionPropertyType.Title:
      return { property, title: { contains: val } }
    case NotionPropertyType.RichText:
      return { property, rich_text: { contains: val } }
    case NotionPropertyType.Number:
      return { property, number: { equals: Number(val) } }
    case NotionPropertyType.Checkbox:
      return { property, checkbox: { equals: val === 'true' } }
    case NotionPropertyType.Date:
      return { property, date: { on_or_after: val } }
    default:
      return { property, rich_text: { contains: val } }
  }
}

// ── Status mapping ───────────────────────────────────────────

const STATUS_TO_LOCAL: Record<string, TaskStatus> = {
  'not started': TaskStatus.NotStarted,
  'todo': TaskStatus.NotStarted,
  'to do': TaskStatus.NotStarted,
  'backlog': TaskStatus.NotStarted,
  'in progress': TaskStatus.AgentWorking,
  'doing': TaskStatus.AgentWorking,
  'in review': TaskStatus.ReadyForReview,
  'done': TaskStatus.Completed,
  'complete': TaskStatus.Completed,
  'completed': TaskStatus.Completed
}

const LOCAL_TO_NOTION_STATUS: Record<string, string[]> = {
  [TaskStatus.NotStarted]: ['Not started', 'To Do', 'Backlog'],
  [TaskStatus.AgentWorking]: ['In progress', 'Doing'],
  [TaskStatus.ReadyForReview]: ['In review'],
  [TaskStatus.Completed]: ['Done', 'Complete', 'Completed']
}

// ── Priority mapping ─────────────────────────────────────────

const PRIORITY_TO_LOCAL: Record<string, string> = {
  'critical': 'critical',
  'urgent': 'critical',
  'p0': 'critical',
  'high': 'high',
  'p1': 'high',
  'medium': 'medium',
  'p2': 'medium',
  'low': 'low',
  'p3': 'low'
}

const LOCAL_TO_NOTION_PRIORITY: Record<string, string[]> = {
  critical: ['Critical', 'Urgent', 'P0'],
  high: ['High', 'P1'],
  medium: ['Medium', 'P2'],
  low: ['Low', 'P3']
}

// ── Property map (auto-detected from DB schema) ──────────────

interface PropertyMap {
  title: string
  status?: { name: string; type: NotionPropertyType.Status | NotionPropertyType.Select }
  priority?: { name: string; type: NotionPropertyType.Select }
  assignee?: { name: string }
  dueDate?: { name: string }
  labels?: { name: string; type: NotionPropertyType.MultiSelect }
}

/** Name heuristics for auto-detecting property roles */
const ASSIGNEE_HEURISTICS = new Set(['assignee', 'owner', 'assigned to'])
const DUE_DATE_HEURISTICS = new Set(['due', 'deadline', 'due date'])
const LABELS_HEURISTICS = new Set(['tags', 'labels', 'category'])

// ── Plugin ───────────────────────────────────────────────────

export class NotionPlugin implements TaskSourcePlugin {
  id = 'notion'
  displayName = 'Notion'
  description = 'Import tasks from a Notion database'
  icon = 'BookOpen'
  requiresMcpServer = false

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'api_token',
        label: 'Integration Token',
        type: 'password',
        required: true,
        placeholder: 'ntn_...',
        description: 'Internal Integration Token from notion.so/profile/integrations'
      },
      {
        key: 'database_id',
        label: 'Database',
        type: 'dynamic-select',
        optionsResolver: 'databases',
        required: true,
        dependsOn: { field: 'api_token', value: '__any__' }
      },
      {
        key: 'filters',
        label: 'Filters',
        type: 'text',
        dependsOn: { field: 'database_id', value: '__any__' },
        description: 'Structured filter configuration (managed by custom form)'
      },
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    const token = config.api_token as string
    if (!token) return []

    const client = new NotionClient(token)

    if (resolverKey === 'databases') {
      try {
        const databases = await client.searchDatabases()
        return databases.map((db) => ({
          value: db.id,
          label: db.title.map((t) => t.plain_text).join('') || 'Untitled'
        }))
      } catch (err) {
        console.error('[notion] Failed to fetch databases:', err)
        return []
      }
    }

    if (resolverKey === 'database_properties') {
      const databaseId = config.database_id as string
      if (!databaseId) return []

      try {
        const db = await client.getDatabase(databaseId)
        const result: ConfigFieldOption[] = []

        // Pre-fetch users if any people property exists
        const hasPeopleProperty = Object.values(db.properties).some(
          (p) => p.type === NotionPropertyType.People
        )
        let userOptions: Array<{ value: string; label: string }> = []
        if (hasPeopleProperty) {
          try {
            const users = await client.getUsers()
            userOptions = users
              .filter((u) => u.type === 'person')
              .map((u) => ({
                value: u.id,
                label: u.name || u.person?.email || u.id
              }))
          } catch {
            // Non-fatal: users endpoint may not be accessible
          }
        }

        for (const [name, prop] of Object.entries(db.properties)) {
          if (!FILTERABLE_PROPERTY_TYPES.has(prop.type as NotionPropertyType)) continue

          const info: { name: string; type: string; options?: Array<{ value: string; label: string }> } = {
            name,
            type: prop.type
          }

          if (prop.type === NotionPropertyType.Status && prop.status) {
            info.options = prop.status.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.Select && prop.select) {
            info.options = prop.select.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.MultiSelect && prop.multi_select) {
            info.options = prop.multi_select.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.People) {
            info.options = userOptions
          }

          result.push({ value: JSON.stringify(info), label: name })
        }

        return result
      } catch (err) {
        console.error('[notion] Failed to fetch database properties:', err)
        return []
      }
    }

    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.api_token || typeof config.api_token !== 'string') {
      return 'Integration token is required'
    }
    if (!config.database_id || typeof config.database_id !== 'string') {
      return 'Database is required'
    }
    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'id',
      title: 'title',
      description: 'content',
      status: 'status',
      priority: 'priority',
      assignee: 'assignee',
      due_date: 'due_date',
      labels: 'labels'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: 'change_status',
        label: 'Change Status',
        icon: 'ArrowRightCircle',
        requiresInput: true,
        inputLabel: 'New Status',
        inputPlaceholder: 'e.g. Done, In Progress'
      },
      {
        id: 'update_priority',
        label: 'Update Priority',
        icon: 'AlertTriangle',
        requiresInput: true,
        inputLabel: 'New Priority',
        inputPlaceholder: 'e.g. High, Low'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const token = config.api_token as string
    const databaseId = config.database_id as string

    const client = new NotionClient(token)

    try {
      // Fetch DB schema and build property map
      const db = await client.getDatabase(databaseId)
      const propMap = this.buildPropertyMap(db)

      // Build filter from config
      const rawFilters = config.filters as NotionFilterConfig[] | undefined
      console.log('[Notion] Raw filter config:', JSON.stringify(rawFilters))
      const notionFilter = this.buildNotionFilter(rawFilters)
      console.log('[Notion] Built Notion filter:', JSON.stringify(notionFilter))

      // Get last synced time for incremental sync
      const source = ctx.db.getTaskSource(sourceId)
      const lastSyncedAt = source?.last_synced_at ?? null

      // Fetch pages
      const pages = await client.queryAllPages(databaseId, notionFilter, lastSyncedAt)

      for (const page of pages) {
        if (page.archived) continue

        try {
          const mapped = this.mapPage(page, propMap)
          if (!mapped.title) continue

          // Fetch page content for description
          const parts: string[] = []
          try {
            const content = await client.getPageContent(page.id)
            if (content) parts.push(content)
          } catch {
            // Non-fatal: page may have no content
          }

          // Append properties table
          const propsSection = this.formatProperties(page, propMap.title)
          if (propsSection) parts.push(propsSection)

          // Append link to Notion page
          if (page.url) {
            parts.push('')
            parts.push(`🔗 [View in Notion](${page.url})`)
          }

          const description = parts.join('\n\n')

          const existing = ctx.db.getTaskByExternalId(sourceId, page.id)

          if (existing) {
            ctx.db.updateTask(existing.id, {
              title: mapped.title,
              description: description || existing.description,
              status: mapped.status,
              priority: mapped.priority,
              assignee: mapped.assignee,
              due_date: mapped.dueDate,
              labels: mapped.labels
            })
            result.updated++
          } else {
            ctx.db.createTask({
              title: mapped.title,
              description,
              type: 'general',
              priority: mapped.priority || 'medium',
              status: mapped.status || TaskStatus.NotStarted,
              assignee: mapped.assignee,
              due_date: mapped.dueDate,
              labels: mapped.labels,
              external_id: page.id,
              source_id: sourceId,
              source: 'Notion'
            })
            result.imported++
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Page ${page.id}: ${msg}`)
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

    const token = config.api_token as string
    const databaseId = config.database_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDatabase(databaseId)
      const propMap = this.buildPropertyMap(db)
      const properties: Record<string, unknown> = {}

      if (changedFields.title && typeof changedFields.title === 'string') {
        properties[propMap.title] = {
          title: [{ text: { content: changedFields.title } }]
        }
      }

      if (changedFields.status && propMap.status) {
        const notionStatus = this.localStatusToNotion(
          changedFields.status as string,
          db.properties[propMap.status.name]
        )
        if (notionStatus) {
          if (propMap.status.type === NotionPropertyType.Status) {
            properties[propMap.status.name] = { status: { name: notionStatus } }
          } else {
            properties[propMap.status.name] = { select: { name: notionStatus } }
          }
        }
      }

      if (changedFields.priority && propMap.priority) {
        const notionPriority = this.localPriorityToNotion(
          changedFields.priority as string,
          db.properties[propMap.priority.name]
        )
        if (notionPriority) {
          properties[propMap.priority.name] = { select: { name: notionPriority } }
        }
      }

      if (changedFields.due_date !== undefined && propMap.dueDate) {
        properties[propMap.dueDate.name] = changedFields.due_date
          ? { date: { start: changedFields.due_date as string } }
          : { date: null }
      }

      if (Object.keys(properties).length > 0) {
        await client.updatePage(task.external_id, properties)
      }
    } catch (err) {
      console.error('[notion] Export update failed:', err)
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
    if (!input) {
      return { success: false, error: 'Input value is required' }
    }

    const token = config.api_token as string
    const databaseId = config.database_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDatabase(databaseId)
      const propMap = this.buildPropertyMap(db)
      const properties: Record<string, unknown> = {}

      if (actionId === 'change_status' && propMap.status) {
        // Try to find a matching status in the DB schema, or use input as-is
        const notionStatus = this.localStatusToNotion(input, db.properties[propMap.status.name]) || input
        if (propMap.status.type === NotionPropertyType.Status) {
          properties[propMap.status.name] = { status: { name: notionStatus } }
        } else {
          properties[propMap.status.name] = { select: { name: notionStatus } }
        }
      } else if (actionId === 'update_priority' && propMap.priority) {
        const notionPriority = this.localPriorityToNotion(input, db.properties[propMap.priority.name]) || input
        properties[propMap.priority.name] = { select: { name: notionPriority } }
      } else {
        return { success: false, error: `Unknown action or missing property: ${actionId}` }
      }

      await client.updatePage(task.external_id, properties)

      const taskUpdate: Record<string, unknown> = {}
      if (actionId === 'change_status') {
        const localStatus = STATUS_TO_LOCAL[input.toLowerCase()]
        if (localStatus) taskUpdate.status = localStatus
      } else if (actionId === 'update_priority') {
        const localPriority = PRIORITY_TO_LOCAL[input.toLowerCase()]
        if (localPriority) taskUpdate.priority = localPriority
      }

      return { success: true, taskUpdate: Object.keys(taskUpdate).length > 0 ? taskUpdate : undefined }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${msg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    const token = config.api_token as string
    if (!token) return []

    try {
      const client = new NotionClient(token)
      const users = await client.getUsers()
      return users
        .filter((u) => u.type === 'person') // Notion user type, not our enum
        .map((u) => ({
          id: u.id,
          email: u.person?.email || '',
          name: u.name || u.person?.email || u.id
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

    const token = config.api_token as string
    const databaseId = config.database_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDatabase(databaseId)
      const propMap = this.buildPropertyMap(db)

      if (!propMap.assignee) {
        return { success: false, error: 'No assignee property found in database' }
      }

      const people = userIds.map((id) => ({ id }))
      await client.updatePage(task.external_id, {
        [propMap.assignee.name]: { people }
      })

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  getSetupDocumentation(): string {
    return `# Notion Integration Setup

## Overview

Import tasks from any Notion database. Supports incremental sync, server-side filtering by database properties, and bidirectional updates.

## Prerequisites

- A Notion workspace
- An Internal Integration (API token)

## Setup Steps

### 1. Create an Integration

1. Go to [notion.so/profile/integrations/internal](https://www.notion.so/profile/integrations/internal)
2. Click **New integration**
3. Enter an **Integration name** (e.g. "20x Tasks")
4. Select your **Associated workspace**
5. Click **Create**

### 2. Configure Capabilities

On the **Configuration** tab after creation:

1. Copy the **Internal Integration Secret** (starts with \`ntn_\`) — click **Show** to reveal it
2. Under **Content capabilities**, ensure these are checked: **Read content**, **Update content**
3. Under **User capabilities**, select **Read user information including email addresses** (needed for assignee mapping)
4. Click **Save changes**

### 3. Grant Database Access

Go to the **Content access** tab:

1. Click **Edit access**
2. Select the database(s) you want to sync
3. Confirm access

Alternatively, open the database in Notion → click **...** → **Connections** → **Connect to** → select your integration.

### 4. Configure the Source

1. Paste your **Integration Token**
2. Select the **Database** from the dropdown
3. Optionally select **Filters** to only import specific items (e.g. Status = In Progress)
4. Click **Save** and **Sync**

## Features

### Smart Filtering
Select property values to filter by. Values from the same property are combined with OR; different properties with AND.

Example: Status = "In Progress" OR "To Do" AND Priority = "High"

### Incremental Sync
After the first full sync, subsequent syncs only fetch pages modified since the last sync.

### Bidirectional Updates
Changes to title, status, priority, and due date sync back to Notion.

## Property Auto-Detection

The integration automatically maps Notion properties to task fields:

| Notion Property Type | Task Field | Detected By |
|---------------------|------------|-------------|
| Title | Title | (every DB has one) |
| Status / Select named "Status" | Status | Type or name |
| Select named "Priority" | Priority | Name |
| People | Assignee | Prefers "Assignee"/"Owner" |
| Date | Due Date | Prefers "Due"/"Deadline"/"Due Date" |
| Multi-select | Labels | Prefers "Tags"/"Labels"/"Category" |

## Troubleshooting

### "Authentication failed"
- Verify your token starts with \`ntn_\`
- Tokens don't expire but can be revoked — check your integration settings

### "Access forbidden"
- Open the database in Notion → **...** → **Connections** → ensure your integration is connected

### No databases appear
- The integration can only see databases explicitly shared with it
- Share at least one database with your integration

### Missing properties in filters
- Only Status, Select, and Multi-select properties appear as filter options
`
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Auto-detect which Notion properties map to task fields
   */
  private buildPropertyMap(
    db: NotionDatabase
  ): PropertyMap {
    const props = db.properties
    const map: PropertyMap = { title: '' }

    for (const [name, schema] of Object.entries(props)) {
      const lower = name.toLowerCase()

      // Title — every DB has exactly one
      if (schema.type === NotionPropertyType.Title) {
        map.title = name
      }

      // Status
      if (!map.status) {
        if (schema.type === NotionPropertyType.Status) {
          map.status = { name, type: NotionPropertyType.Status }
        } else if (schema.type === NotionPropertyType.Select && lower === 'status') {
          map.status = { name, type: NotionPropertyType.Select }
        }
      }

      // Priority
      if (!map.priority && schema.type === NotionPropertyType.Select && lower === 'priority') {
        map.priority = { name, type: NotionPropertyType.Select }
      }

      // Assignee
      if (schema.type === NotionPropertyType.People) {
        if (!map.assignee) {
          if (ASSIGNEE_HEURISTICS.has(lower)) {
            map.assignee = { name }
          } else {
            map.assignee = { name } // fallback to first People property
          }
        }
      }

      // Due date
      if (schema.type === NotionPropertyType.Date) {
        if (!map.dueDate || DUE_DATE_HEURISTICS.has(lower)) {
          map.dueDate = { name }
        }
      }

      // Labels
      if (schema.type === NotionPropertyType.MultiSelect) {
        if (!map.labels || LABELS_HEURISTICS.has(lower)) {
          map.labels = { name, type: NotionPropertyType.MultiSelect }
        }
      }
    }

    return map
  }

  /**
   * Extract task fields from a Notion page using the property map
   */
  private mapPage(
    page: NotionPage,
    propMap: PropertyMap
  ): {
    title: string
    status?: string
    priority?: string
    assignee?: string
    dueDate?: string | null
    labels?: string[]
  } {
    const props = page.properties

    // Title
    const titleProp = props[propMap.title]
    const title = titleProp?.title?.map((t) => t.plain_text).join('') || ''

    // Status
    let status: string | undefined
    if (propMap.status) {
      const statusProp = props[propMap.status.name]
      if (statusProp) {
        const rawStatus = propMap.status.type === NotionPropertyType.Status
          ? statusProp.status?.name
          : statusProp.select?.name
        if (rawStatus) {
          status = STATUS_TO_LOCAL[rawStatus.toLowerCase()] || TaskStatus.NotStarted
        }
      }
    }

    // Priority
    let priority: string | undefined
    if (propMap.priority) {
      const priProp = props[propMap.priority.name]
      const rawPriority = priProp?.select?.name
      if (rawPriority) {
        priority = PRIORITY_TO_LOCAL[rawPriority.toLowerCase()] || 'medium'
      }
    }

    // Assignee
    let assignee: string | undefined
    if (propMap.assignee) {
      const assigneeProp = props[propMap.assignee.name]
      if (assigneeProp?.people && assigneeProp.people.length > 0) {
        const person = assigneeProp.people[0]
        assignee = person.name || person.person?.email || person.id
      }
    }

    // Due date
    let dueDate: string | null = null
    if (propMap.dueDate) {
      const dateProp = props[propMap.dueDate.name]
      if (dateProp?.date?.start) {
        dueDate = dateProp.date.start.split('T')[0]
      }
    }

    // Labels
    let labels: string[] | undefined
    if (propMap.labels) {
      const labelProp = props[propMap.labels.name]
      if (labelProp?.multi_select) {
        labels = labelProp.multi_select.map((s) => s.name)
      }
    }

    return { title, status, priority, assignee, dueDate, labels }
  }

  /**
   * Format all Notion page properties as a markdown section.
   * Skips the title property (already used as task title).
   */
  private formatProperties(page: NotionPage, titlePropName: string): string {
    const lines: string[] = []

    for (const [name, prop] of Object.entries(page.properties)) {
      if (name === titlePropName) continue

      const val = this.formatPropertyValue(prop)
      if (val) {
        lines.push(`| ${name} | ${val} |`)
      }
    }

    if (lines.length === 0) return ''

    return '---\n\n**Properties**\n\n| Property | Value |\n| --- | --- |\n' + lines.join('\n')
  }

  /**
   * Format a single Notion property value as a string
   */
  private formatPropertyValue(prop: NotionPropertyValue): string | null {
    switch (prop.type) {
      case 'title':
        return prop.title?.map((t) => t.plain_text).join('') || null
      case 'rich_text':
        return prop.rich_text?.map((t) => t.plain_text).join('') || null
      case 'status':
        return prop.status?.name || null
      case 'select':
        return prop.select?.name || null
      case 'multi_select':
        return prop.multi_select?.map((s) => s.name).join(', ') || null
      case 'people':
        return prop.people?.map((p) => p.name || p.person?.email || p.id).join(', ') || null
      case 'date': {
        if (!prop.date?.start) return null
        const start = prop.date.start.split('T')[0]
        const end = prop.date.end?.split('T')[0]
        return end ? `${start} → ${end}` : start
      }
      case 'number':
        return prop.number != null ? String(prop.number) : null
      case 'checkbox':
        return prop.checkbox ? 'Yes' : 'No'
      case 'url':
        return prop.url || null
      default:
        return null
    }
  }

  /**
   * Build Notion API filter from structured filter config.
   * Same property values → OR, different properties → AND.
   */
  private buildNotionFilter(
    filters: NotionFilterConfig[] | undefined
  ): NotionFilter | undefined {
    if (!filters || filters.length === 0) return undefined

    const andClauses: NotionFilter[] = []

    for (const filter of filters) {
      if (!filter.property || !filter.type || filter.values.length === 0) continue

      const nonEmptyValues = filter.values.filter((v) => v !== '')
      if (nonEmptyValues.length === 0) continue

      const orClauses = nonEmptyValues.map((val) =>
        buildPropertyFilter(filter.type, filter.property, val)
      ) as NotionFilter[]

      if (orClauses.length === 1) {
        andClauses.push(orClauses[0])
      } else {
        andClauses.push({ or: orClauses })
      }
    }

    if (andClauses.length === 0) return undefined
    if (andClauses.length === 1) return andClauses[0]
    return { and: andClauses }
  }

  /**
   * Map local status to a Notion status option name
   */
  private localStatusToNotion(
    localStatus: string,
    propSchema: NotionPropertySchema | undefined
  ): string | null {
    if (!propSchema) return null

    const candidates = LOCAL_TO_NOTION_STATUS[localStatus]
    if (!candidates) return null

    // Get available options from schema
    const options = propSchema.type === NotionPropertyType.Status
      ? propSchema.status?.options
      : propSchema.select?.options
    if (!options) return null

    const optionNames = options.map((o) => o.name)

    // Find first matching candidate
    for (const candidate of candidates) {
      const match = optionNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
      if (match) return match
    }

    return null
  }

  /**
   * Map local priority to a Notion select option name
   */
  private localPriorityToNotion(
    localPriority: string,
    propSchema: NotionPropertySchema | undefined
  ): string | null {
    if (!propSchema?.select?.options) return null

    const candidates = LOCAL_TO_NOTION_PRIORITY[localPriority]
    if (!candidates) return null

    const optionNames = propSchema.select.options.map((o) => o.name)

    for (const candidate of candidates) {
      const match = optionNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
      if (match) return match
    }

    return null
  }
}
