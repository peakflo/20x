/**
 * Linear Task Source Plugin
 *
 * Integrates Linear.app as a task source using OAuth2 authentication.
 * Supports importing issues, bidirectional sync, and Linear-specific actions.
 */

import { writeFileSync } from 'fs'
import { join, extname } from 'path'
import type { TaskRecord } from '../database'
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
import { LinearClient, type LinearIssue } from './linear-client'

export class LinearPlugin implements TaskSourcePlugin {
  id = 'linear'
  displayName = 'Linear'
  description = 'Import and manage issues from Linear.app using OAuth2'
  icon = 'Zap'
  requiresMcpServer = false

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: '_setup_link',
        label: 'Setup Instructions',
        type: 'text',
        required: false,
        placeholder: 'https://linear.app/settings/api/applications/new',
        description: '👉 Click to create a new OAuth application in Linear. Set redirect URI to: nuanu://oauth/callback'
      },
      {
        key: 'client_id',
        label: 'OAuth Client ID',
        type: 'text',
        required: true,
        description: 'Copy the Client ID from your Linear OAuth application'
      },
      {
        key: 'client_secret',
        label: 'OAuth Client Secret',
        type: 'password',
        required: true,
        description: 'Copy the Client Secret from your Linear OAuth application (kept secure locally)'
      },
      {
        key: 'scope',
        label: 'Permissions',
        type: 'select',
        default: 'read,write',
        options: [
          { value: 'read', label: 'Read' },
          { value: 'write', label: 'Write' },
          { value: 'read,write', label: 'Read + Write' },
          { value: 'read,write,issues:create', label: 'Read + Write + Create Issues' },
          { value: 'read,write,issues:create,comments:create', label: 'All Permissions' }
        ],
        description: 'OAuth scopes for Linear API access'
      },
      {
        key: 'assignee_id',
        label: 'Assigned to (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'users',
        required: false,
        description: 'Filter issues by assignee. Leave empty to sync all issues.'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    if (resolverKey === 'users') {
      // Case 1: No sourceId yet (initial setup) - return empty, user can select users after OAuth
      if (!ctx.sourceId) {
        console.log('[linear-plugin] No sourceId yet - users will be available after OAuth')
        return []
      }

      // Case 2: No OAuth manager available
      if (!ctx.oauthManager) {
        console.error('[linear-plugin] OAuth manager not available')
        return []
      }

      try {
        // Case 3: Check if OAuth token exists
        const token = await ctx.oauthManager.getValidToken(ctx.sourceId)
        if (!token) {
          console.log('[linear-plugin] No OAuth token found - please complete OAuth flow first')
          return []
        }

        console.log('[linear-plugin] Fetching users from Linear...')

        // Case 4: Token exists - fetch users
        const client = new LinearClient(token)
        const users = await client.getUsers()
        console.log(`[linear-plugin] Successfully fetched ${users.length} users from Linear`)

        if (users.length === 0) {
          console.warn('[linear-plugin] No users found in Linear workspace')
        }

        return users.map(u => ({ value: u.id, label: u.displayName || u.name || u.email }))
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        console.error('[linear-plugin] Failed to fetch users:', errorMsg)
        console.error('[linear-plugin] Full error:', error)

        // If it's an auth error, return empty (user needs to re-auth)
        if (errorMsg.includes('authentication') || errorMsg.includes('401')) {
          console.log('[linear-plugin] Authentication failed - OAuth token may be expired')
        }

        return []
      }
    }
    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.client_id || typeof config.client_id !== 'string') {
      return 'OAuth Client ID is required'
    }
    if (!config.client_secret || typeof config.client_secret !== 'string') {
      return 'OAuth Client Secret is required'
    }
    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'id',
      title: 'title',
      description: 'description',
      status: 'state.name',
      priority: 'priority',
      assignee: 'assignee.displayName',
      due_date: 'dueDate',
      labels: 'labels'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: 'change_status',
        label: 'Change Status',
        icon: 'ArrowRight',
        requiresInput: true,
        inputLabel: 'New Status',
        inputPlaceholder: 'e.g., In Progress, Done'
      },
      {
        id: 'update_priority',
        label: 'Update Priority',
        icon: 'Flag',
        requiresInput: true,
        inputLabel: 'Priority',
        inputPlaceholder: 'e.g., Urgent, High, Medium, Low'
      },
      {
        id: 'add_comment',
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }

    if (!ctx.oauthManager) {
      result.errors.push('OAuth manager not available')
      return result
    }

    try {
      // Get valid access token
      const token = await ctx.oauthManager.getValidToken(sourceId)
      if (!token) {
        result.errors.push('OAuth token expired. Please re-authenticate.')
        return result
      }

      const client = new LinearClient(token)
      const assigneeId = config.assignee_id as string | undefined

      // Fetch all issues from Linear
      const issues = await client.getIssues(assigneeId)

      for (const issue of issues) {
        try {
          const mapped = this.mapLinearIssue(issue)

          console.log(`[linear-plugin] Processing issue: ${issue.title}`)
          console.log(`[linear-plugin] Attachments count: ${issue.attachments?.nodes?.length || 0}`)
          if (issue.attachments?.nodes && issue.attachments.nodes.length > 0) {
            console.log('[linear-plugin] Attachment details:', JSON.stringify(issue.attachments.nodes, null, 2))
          }

          // Check if task already exists
          const existing = ctx.db.getTaskByExternalId(sourceId, issue.id)

          let taskId: string
          if (existing) {
            // Update existing task
            ctx.db.updateTask(existing.id, mapped)
            taskId = existing.id
            result.updated++
          } else {
            // Create new task
            const created = ctx.db.createTask({
              ...mapped,
              title: mapped.title || issue.title,
              source_id: sourceId,
              external_id: issue.id,
              source: 'Linear',
              status: mapped.status || 'not_started'
            })
            if (!created) {
              console.error('[linear-plugin] Failed to create task:', issue.id)
              continue
            }
            taskId = created.id
            result.imported++
          }

          // Extract and download file attachments from description and comments
          const fileUrls = this.extractLinearFileUrls(issue)
          console.log(`[linear-plugin] Found ${fileUrls.length} file URLs in issue content`)
          if (fileUrls.length > 0) {
            console.log(`[linear-plugin] File URLs:`, fileUrls)
            await this.downloadLinearFiles(taskId, fileUrls, client, ctx)
          }

          // Also download link attachments if any
          if (issue.attachments?.nodes && issue.attachments.nodes.length > 0) {
            console.log(`[linear-plugin] Found ${issue.attachments.nodes.length} link attachments`)
            await this.downloadAttachments(taskId, issue.attachments.nodes, client, ctx)
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Failed to import issue "${issue.title}": ${errorMsg}`)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${errorMsg}`)
    }

    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void> {
    if (!ctx.oauthManager || !task.source_id || !task.external_id) return

    try {
      const token = await ctx.oauthManager.getValidToken(task.source_id)
      if (!token) return

      const client = new LinearClient(token)
      const updates: {
        stateId?: string
        priority?: number
        title?: string
        description?: string
      } = {}

      // Map changed fields to Linear format
      if (changedFields.status) {
        // Get the issue to find its team
        const issue = await client.getIssue(task.external_id)
        if (issue && issue.team?.id) {
          // Fetch workflow states for the team
          const states = await client.getWorkflowStates(issue.team.id)
          const targetState = this.findStateForStatus(states, changedFields.status as string)
          if (targetState) {
            updates.stateId = targetState.id
          }
        }
      }

      if (changedFields.priority) {
        updates.priority = this.mapPriorityToLinear(changedFields.priority as string)
      }
      if (changedFields.title) {
        updates.title = changedFields.title as string
      }
      if (changedFields.description) {
        updates.description = changedFields.description as string
      }

      if (Object.keys(updates).length > 0) {
        await client.updateIssue(task.external_id, updates)
      }
    } catch (err) {
      console.error('[linear-plugin] Export update failed:', err)
    }
  }

  /**
   * Find the appropriate Linear workflow state for a local status
   */
  private findStateForStatus(states: Array<{ id: string; name: string; type: string }>, localStatus: string): { id: string; name: string } | null {
    const statusLower = localStatus.toLowerCase()

    // Map local status to Linear state types
    if (statusLower === 'completed') {
      // Find "done" or "completed" state
      const completedState = states.find(s =>
        s.type === 'completed' ||
        s.name.toLowerCase().includes('done') ||
        s.name.toLowerCase().includes('completed')
      )
      return completedState || null
    }

    if (statusLower === 'agent_working' || statusLower === 'in_progress') {
      // Find "in progress" or "started" state
      const inProgressState = states.find(s =>
        s.type === 'started' ||
        s.name.toLowerCase().includes('progress') ||
        s.name.toLowerCase().includes('started')
      )
      return inProgressState || null
    }

    if (statusLower === 'not_started' || statusLower === 'todo') {
      // Find "todo" or "backlog" state
      const todoState = states.find(s =>
        s.type === 'unstarted' ||
        s.name.toLowerCase().includes('todo') ||
        s.name.toLowerCase().includes('backlog')
      )
      return todoState || null
    }

    return null
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (!ctx.oauthManager || !task.source_id || !task.external_id) {
      return { success: false, error: 'OAuth manager or task source not available' }
    }

    try {
      const token = await ctx.oauthManager.getValidToken(task.source_id)
      if (!token) {
        return { success: false, error: 'OAuth token expired. Please re-authenticate.' }
      }

      const client = new LinearClient(token)

      switch (actionId) {
        case 'add_comment':
          if (!input) {
            return { success: false, error: 'Comment text is required' }
          }
          await client.addComment(task.external_id, input)
          return { success: true }

        case 'update_priority':
          if (!input) {
            return { success: false, error: 'Priority is required' }
          }
          const priority = this.parsePriorityInput(input)
          if (priority === null) {
            return { success: false, error: 'Invalid priority. Use: Urgent, High, Medium, Low, or None' }
          }
          await client.updateIssue(task.external_id, { priority })
          return {
            success: true,
            taskUpdate: { priority: this.mapPriorityFromLinear(priority) }
          }

        case 'change_status':
          if (!input) {
            return { success: false, error: 'Status is required' }
          }
          // For status changes, we'd need to fetch workflow states and match by name
          // This is a simplified implementation
          return { success: false, error: 'Status change not yet implemented' }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${errorMsg}` }
    }
  }

  /**
   * Extract Linear file upload URLs from issue description and comments
   */
  private extractLinearFileUrls(issue: LinearIssue): Array<{ url: string; filename: string }> {
    const fileUrls: Array<{ url: string; filename: string }> = []

    // Extract from description
    if (issue.description) {
      const extracted = this.extractFilesFromMarkdown(issue.description)
      fileUrls.push(...extracted)
    }

    // Extract from comments
    if (issue.comments?.nodes) {
      issue.comments.nodes.forEach(comment => {
        if (comment.body) {
          const extracted = this.extractFilesFromMarkdown(comment.body)
          fileUrls.push(...extracted)
        }
      })
    }

    // Deduplicate URLs
    const uniqueUrls = new Map<string, string>()
    fileUrls.forEach(({ url, filename }) => {
      if (!uniqueUrls.has(url)) {
        uniqueUrls.set(url, filename)
      }
    })

    return Array.from(uniqueUrls.entries()).map(([url, filename]) => ({ url, filename }))
  }

  /**
   * Extract files from markdown content, preserving filenames from markdown syntax
   */
  private extractFilesFromMarkdown(markdown: string): Array<{ url: string; filename: string }> {
    const files: Array<{ url: string; filename: string }> = []

    // Pattern 1: ![alt text](https://uploads.linear.app/...)
    const imagePattern = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g
    let match: RegExpExecArray | null
    while ((match = imagePattern.exec(markdown)) !== null) {
      const altText = match[1]
      const url = match[2]
      const filename = altText && altText.trim() ? altText.trim() : this.extractFilenameFromLinearUrl(url)
      files.push({ url, filename })
    }

    // Pattern 2: [link text](https://uploads.linear.app/...)
    const linkPattern = /\[([^\]]+)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g
    while ((match = linkPattern.exec(markdown)) !== null) {
      const linkText = match[1]
      const url = match[2]
      // Skip if already added as image
      if (!files.some(f => f.url === url)) {
        const filename = linkText && linkText.trim() ? linkText.trim() : this.extractFilenameFromLinearUrl(url)
        files.push({ url, filename })
      }
    }

    // Pattern 3: Plain URLs without markdown syntax
    const plainUrlPattern = /https:\/\/uploads\.linear\.app\/[^\s)]+/g
    const plainUrls = markdown.match(plainUrlPattern) || []
    plainUrls.forEach(url => {
      // Skip if already added
      if (!files.some(f => f.url === url)) {
        const filename = this.extractFilenameFromLinearUrl(url)
        files.push({ url, filename })
      }
    })

    return files
  }

  /**
   * Extract filename from Linear upload URL
   */
  private extractFilenameFromLinearUrl(url: string): string {
    // Linear URLs are like: https://uploads.linear.app/{id}/{id}/{id}
    // Try to get the last segment as filename
    const parts = url.split('/')
    const lastPart = parts[parts.length - 1]

    // If it has an extension, use it; otherwise generate a name
    if (lastPart && lastPart.includes('.')) {
      return lastPart
    }

    return `linear-file-${lastPart || Date.now()}`
  }

  /**
   * Extract attachment ID from Linear upload URL
   * URLs are like: https://uploads.linear.app/{org}/{team}/{attachment-id}
   */
  private extractAttachmentIdFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url)
      if (!urlObj.hostname.includes('linear.app')) return null

      // Extract last segment as attachment ID (UUID format)
      const parts = urlObj.pathname.split('/').filter(p => p)
      const lastPart = parts[parts.length - 1]

      // Validate it's a UUID-like string
      if (lastPart && /^[a-f0-9-]{36}$/i.test(lastPart)) {
        return lastPart
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Download Linear file uploads and save locally
   */
  private async downloadLinearFiles(
    taskId: string,
    files: Array<{ url: string; filename: string }>,
    client: LinearClient,
    ctx: PluginContext
  ): Promise<void> {
    console.log(`[linear-plugin] downloadLinearFiles called for task ${taskId} with ${files.length} files`)

    const task = ctx.db.getTask(taskId)
    if (!task) {
      console.error(`[linear-plugin] Task ${taskId} not found`)
      return
    }

    const existingAttachments = task.attachments || []
    const existingUrls = new Set(existingAttachments.map((a: any) => a.linear_url))

    for (const file of files) {
      // Skip if already downloaded
      if (existingUrls.has(file.url)) {
        console.log(`[linear-plugin] Skipping already downloaded file: ${file.url}`)
        continue
      }

      try {
        console.log(`[linear-plugin] Downloading Linear file from ${file.url}`)

        // Try to get original filename from Linear API
        let originalFilename = file.filename
        const attachmentId = this.extractAttachmentIdFromUrl(file.url)

        if (attachmentId) {
          console.log(`[linear-plugin] Extracted attachment ID: ${attachmentId}`)
          const metadata = await client.getAttachmentMetadata(attachmentId)
          if (metadata?.title) {
            originalFilename = metadata.title
            console.log(`[linear-plugin] Got original filename from Linear API: ${originalFilename}`)
          }
        }

        // Download the file with metadata
        const { buffer, filename, contentType } = await client.downloadAttachment(file.url)

        // Priority: Linear API title > Content-Disposition header > markdown extracted name
        const actualFilename = filename || originalFilename
        console.log(`[linear-plugin] File metadata - name: ${actualFilename}, type: ${contentType}, size: ${buffer.length} bytes`)

        // Detect MIME type from content if not provided
        const detectedMimeType = contentType || this.detectMimeTypeFromContent(buffer) || this.guessMimeType(actualFilename)

        // Generate unique ID for the attachment
        const attachmentId2 = crypto.randomUUID()

        // Get attachments directory for this task
        const attachmentsDir = ctx.db.getAttachmentsDir(taskId)
        const filePath = join(attachmentsDir, `${attachmentId2}-${actualFilename}`)

        // Save file
        writeFileSync(filePath, buffer)

        // Add to task attachments
        const newAttachment = {
          id: attachmentId2,
          filename: actualFilename,
          size: buffer.length,
          mime_type: detectedMimeType,
          added_at: new Date().toISOString(),
          linear_url: file.url
        }

        ctx.db.updateTask(taskId, {
          attachments: [...existingAttachments, newAttachment]
        })

        console.log(`[linear-plugin] Saved Linear file: ${actualFilename} (${newAttachment.size} bytes, ${newAttachment.mime_type})`)

        // Update for next iteration
        existingAttachments.push(newAttachment)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[linear-plugin] Failed to download Linear file ${file.filename}:`, errorMsg)
      }
    }
  }

  /**
   * Download and save Linear attachments locally
   */
  private async downloadAttachments(
    taskId: string,
    attachments: Array<{ id: string; url: string; title?: string; subtitle?: string; metadata?: { size?: number } }>,
    client: LinearClient,
    ctx: PluginContext
  ): Promise<void> {
    console.log(`[linear-plugin] downloadAttachments called for task ${taskId} with ${attachments.length} attachments`)

    const task = ctx.db.getTask(taskId)
    if (!task) {
      console.error(`[linear-plugin] Task ${taskId} not found`)
      return
    }

    const existingAttachments = task.attachments || []
    console.log(`[linear-plugin] Existing attachments: ${existingAttachments.length}`)
    const existingUrls = new Set(existingAttachments.map((a: any) => a.linear_url))

    for (const attachment of attachments) {
      console.log(`[linear-plugin] Processing attachment:`, {
        id: attachment.id,
        url: attachment.url,
        title: attachment.title,
        alreadyExists: existingUrls.has(attachment.url)
      })
      // Skip if already downloaded
      if (existingUrls.has(attachment.url)) continue

      try {
        console.log(`[linear-plugin] Downloading attachment: ${attachment.title || attachment.url}`)

        // Download the file with metadata
        const { buffer, filename, contentType } = await client.downloadAttachment(attachment.url)

        // Determine filename - prefer from response headers, then title, then fallback
        const actualFilename = filename || attachment.title || attachment.subtitle || `attachment-${attachment.id}`
        const ext = extname(actualFilename) || this.guessExtensionFromUrl(attachment.url)
        const finalFilename = ext ? actualFilename : `${actualFilename}.bin`

        // Generate unique ID for the attachment
        const attachmentId = crypto.randomUUID()

        // Get attachments directory for this task
        const attachmentsDir = ctx.db.getAttachmentsDir(taskId)
        const filePath = join(attachmentsDir, `${attachmentId}-${finalFilename}`)

        // Save file
        writeFileSync(filePath, buffer)

        // Add to task attachments
        const newAttachment = {
          id: attachmentId,
          filename: finalFilename,
          size: attachment.metadata?.size || buffer.length,
          mime_type: contentType || this.guessMimeType(finalFilename),
          added_at: new Date().toISOString(),
          linear_url: attachment.url // Store original URL for reference
        }

        ctx.db.updateTask(taskId, {
          attachments: [...existingAttachments, newAttachment]
        })

        console.log(`[linear-plugin] Saved attachment: ${finalFilename} (${newAttachment.size} bytes)`)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[linear-plugin] Failed to download attachment ${attachment.title || attachment.url}:`, errorMsg)
      }
    }
  }

  /**
   * Guess file extension from URL
   */
  private guessExtensionFromUrl(url: string): string {
    const match = url.match(/\.(jpg|jpeg|png|gif|pdf|doc|docx|xls|xlsx|zip|txt|csv)(\?|$)/i)
    return match ? `.${match[1]}` : ''
  }

  /**
   * Detect MIME type from file content (magic bytes)
   */
  private detectMimeTypeFromContent(buffer: Buffer): string | null {
    // Check magic bytes for common file types
    if (buffer.length < 4) return null

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }

    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }

    // PDF: 25 50 44 46
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return 'application/pdf'
    }

    // ZIP: 50 4B 03 04 or 50 4B 05 06
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && (buffer[2] === 0x03 || buffer[2] === 0x05)) {
      return 'application/zip'
    }

    return null
  }

  /**
   * Guess MIME type from filename
   */
  private guessMimeType(filename: string): string {
    const ext = extname(filename).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.document',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.7z': 'application/x-7z-compressed',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo'
    }
    return mimeTypes[ext] || 'application/octet-stream'
  }

  /**
   * Map Linear issue to local task format
   */
  private mapLinearIssue(issue: LinearIssue): Partial<TaskRecord> {
    return {
      title: issue.title,
      description: issue.description || '',
      status: this.mapStatusFromLinear(issue.state.name),
      priority: this.mapPriorityFromLinear(issue.priority),
      assignee: issue.assignee?.displayName || '',
      due_date: issue.dueDate || null,
      labels: issue.labels?.nodes.map(l => l.name) || []
    }
  }

  /**
   * Map Linear status to local status
   */
  private mapStatusFromLinear(linearStatus: string): string {
    const lower = linearStatus.toLowerCase()

    if (lower.includes('backlog') || lower.includes('todo')) {
      return 'not_started'
    }
    if (lower.includes('progress') || lower.includes('started')) {
      return 'agent_working'
    }
    if (lower.includes('review')) {
      return 'ready_for_review'
    }
    if (lower.includes('done') || lower.includes('complete') || lower.includes('canceled')) {
      return 'completed'
    }

    // Default to not_started for unknown statuses
    return 'not_started'
  }

  /**
   * Map Linear priority to local priority
   * Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
   */
  private mapPriorityFromLinear(linearPriority: number): string {
    const priorityMap: Record<number, string> = {
      0: 'low',
      1: 'critical',
      2: 'high',
      3: 'medium',
      4: 'low'
    }
    return priorityMap[linearPriority] || 'medium'
  }

  /**
   * Map local priority to Linear priority
   */
  private mapPriorityToLinear(localPriority: string): number {
    const priorityMap: Record<string, number> = {
      'critical': 1,
      'high': 2,
      'medium': 3,
      'low': 4
    }
    return priorityMap[localPriority] || 3
  }

  /**
   * Parse user input for priority (e.g., "Urgent", "High", "2")
   */
  private parsePriorityInput(input: string): number | null {
    const lower = input.toLowerCase().trim()

    const priorityMap: Record<string, number> = {
      'urgent': 1,
      'critical': 1,
      'high': 2,
      'medium': 3,
      'med': 3,
      'low': 4,
      'none': 0,
      'no priority': 0
    }

    if (priorityMap[lower] !== undefined) {
      return priorityMap[lower]
    }

    // Try parsing as number
    const num = parseInt(input, 10)
    if (!isNaN(num) && num >= 0 && num <= 4) {
      return num
    }

    return null
  }
}
