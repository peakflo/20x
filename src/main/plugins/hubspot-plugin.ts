/**
 * HubSpot Tickets Task Source Plugin
 *
 * Integrates HubSpot CRM Tickets as a task source.
 * Supports dual authentication: OAuth2 (recommended) + Private App tokens (fallback).
 * Enables importing tickets, syncing status/priority, and executing ticket actions.
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
import { HubSpotClient, type HubSpotTicket, type HubSpotPipeline } from './hubspot-client'

/**
 * Attachment metadata with HubSpot-specific fields
 */
interface AttachmentMetadata {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
  hubspot_file_id?: string // HubSpot file ID for deduplication
  hubspot_url?: string // Current signed URL (changes on each sync)
}

export class HubSpotPlugin implements TaskSourcePlugin {
  id = 'hubspot'
  displayName = 'HubSpot'
  description = 'Import and manage support tickets from HubSpot CRM'
  icon = 'Ticket'
  requiresMcpServer = false

  // Cache pipelines to map stage IDs to ticket states (OPEN/CLOSED)
  private pipelineCache: Map<string, HubSpotPipeline[]> = new Map()

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'auth_type',
        label: 'Authentication Method',
        type: 'select',
        required: true,
        default: 'oauth',
        options: [
          { value: 'oauth', label: 'OAuth 2.0 (Recommended)' },
          { value: 'private_app', label: 'Private App Access Token' }
        ],
        description: 'Choose how to authenticate with HubSpot'
      },
      // OAuth fields
      {
        key: '_oauth_setup_link',
        label: 'OAuth Setup',
        type: 'text',
        required: false,
        placeholder: 'https://developers.hubspot.com/apps',
        description:
          '👉 Create OAuth app at https://developers.hubspot.com/apps. Set redirect URI to: http://localhost:3000/callback (or ports 3000-3010)'
      },
      {
        key: 'client_id',
        label: 'OAuth Client ID',
        type: 'text',
        required: false,
        description: 'Copy from your HubSpot OAuth app settings'
      },
      {
        key: 'client_secret',
        label: 'OAuth Client Secret',
        type: 'password',
        required: false,
        description: 'Copy from your HubSpot OAuth app settings (stored securely)'
      },
      // Private App fields
      {
        key: 'access_token',
        label: 'Private App Access Token',
        type: 'password',
        required: false,
        description: 'Get from Settings > Integrations > Private Apps. Requires "tickets", "crm.objects.contacts.read", "crm.objects.owners.read", "files", and "forms-uploaded-files" scopes.'
      },
      // Filter options
      {
        key: 'pipeline_id',
        label: 'Pipeline Filter (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'pipelines',
        required: false,
        description: 'Filter tickets by pipeline. Leave empty to sync all pipelines.'
      },
      {
        key: 'owner_id',
        label: 'Owner Filter (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'owners',
        required: false,
        description: 'Filter tickets by owner. Leave empty to sync all tickets.'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    // Need a source ID to resolve options (fetching from HubSpot)
    if (!ctx.sourceId) {
      console.log('[hubspot-plugin] No sourceId yet - options will be available after configuration')
      return []
    }

    try {
      // Get access token
      const token = await this.getAccessToken(ctx.sourceId, config, ctx)
      if (!token) {
        console.log('[hubspot-plugin] No access token found - please complete authentication first')
        return []
      }

      const client = new HubSpotClient(token)

      if (resolverKey === 'owners') {
        const owners = await client.getOwners()
        console.log(`[hubspot-plugin] Fetched ${owners.length} owners`)
        return owners.map((o) => ({
          value: o.id,
          label: `${o.firstName} ${o.lastName}`.trim() || o.email
        }))
      }

      if (resolverKey === 'pipelines') {
        const pipelines = await client.getPipelines()
        console.log(`[hubspot-plugin] Fetched ${pipelines.length} pipelines`)

        // Cache pipelines for status mapping
        this.pipelineCache.set(ctx.sourceId, pipelines)

        return pipelines.map((p) => ({
          value: p.id,
          label: p.label
        }))
      }

      return []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[hubspot-plugin] Failed to resolve options for ${resolverKey}:`, errorMsg)

      // If auth error, clear message
      if (errorMsg.includes('authentication') || errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log('[hubspot-plugin] Authentication failed - token may be expired or invalid')
      }

      return []
    }
  }

  validateConfig(config: Record<string, unknown>): string | null {
    const authType = config.auth_type as string

    if (authType === 'oauth') {
      if (!config.client_id || typeof config.client_id !== 'string') {
        return 'OAuth Client ID is required for OAuth authentication'
      }
      if (!config.client_secret || typeof config.client_secret !== 'string') {
        return 'OAuth Client Secret is required for OAuth authentication'
      }
    } else if (authType === 'private_app') {
      if (!config.access_token || typeof config.access_token !== 'string') {
        return 'Private App Access Token is required for Private App authentication'
      }
    } else {
      return 'Invalid authentication type. Choose OAuth 2.0 or Private App.'
    }

    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'id',
      title: 'properties.subject',
      description: 'properties.content',
      status: 'properties.hs_pipeline_stage',
      priority: 'properties.hs_ticket_priority',
      assignee: 'properties.hubspot_owner_id',
      due_date: 'properties.hs_due_date',
      labels: 'properties.hs_ticket_category',
      resolution: 'properties.hs_resolution'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: 'add_note',
        label: 'Add Note',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Note',
        inputPlaceholder: 'Enter note...'
      },
      {
        id: 'update_priority',
        label: 'Update Priority',
        icon: 'Flag',
        requiresInput: true,
        inputLabel: 'Priority',
        inputPlaceholder: 'HIGH, MEDIUM, or LOW'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }

    try {
      // Get access token (OAuth or Private App)
      const token = await this.getAccessToken(sourceId, config, ctx)
      if (!token) {
        result.errors.push('Authentication failed. Please configure OAuth or provide a Private App token.')
        return result
      }

      const client = new HubSpotClient(token)

      // Fetch pipelines first for status mapping
      const pipelines = await client.getPipelines()
      this.pipelineCache.set(sourceId, pipelines)

      // Determine sync strategy based on last sync time
      const taskSource = ctx.db.getTaskSource(sourceId)
      const lastSyncedAt = taskSource?.last_synced_at
      let modifiedAfter: string | undefined
      let onlyOpen = false

      if (lastSyncedAt) {
        // Incremental sync: only fetch tickets updated in last 24 hours
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        modifiedAfter = oneDayAgo
        onlyOpen = false // Include all tickets (open and closed) for incremental sync
        console.log(`[hubspot-plugin] Incremental sync - fetching tickets modified after ${modifiedAfter}`)
      } else {
        // Initial sync: fetch only OPEN tickets
        onlyOpen = true
        console.log(`[hubspot-plugin] Initial sync - fetching OPEN tickets only`)
      }

      // Fetch tickets with optional filters
      const pipelineId = config.pipeline_id as string | undefined
      const ownerId = config.owner_id as string | undefined
      const tickets = await client.getTickets(pipelineId, ownerId, modifiedAfter, onlyOpen)

      // Process each ticket
      for (const ticket of tickets) {
        try {
          // Resolve owner name if present
          let ownerName = ''
          if (ticket.properties.hubspot_owner_id) {
            const owner = await client.getOwner(ticket.properties.hubspot_owner_id)
            if (owner) {
              ownerName = `${owner.firstName} ${owner.lastName}`.trim() || owner.email
            }
          }

          // Fetch contact info if associated
          let contactInfo = ''
          if (ticket.associations?.contacts?.results?.[0]) {
            const contactId = ticket.associations.contacts.results[0].id
            const contact = await client.getContact(contactId)
            if (contact) {
              const name = `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim()
              contactInfo = name || contact.properties.email || ''
            }
          }

          const mapped = await this.mapHubSpotTicket(ticket, ownerName, contactInfo, pipelines, client)

          // Skip completed tickets during incremental sync (recently closed tickets)
          // Note: Initial sync already filters to OPEN tickets at API level
          if (mapped.status === 'completed') {
            continue
          }

          // Check if task already exists
          const existing = ctx.db.getTaskByExternalId(sourceId, ticket.id)

          let taskId: string
          if (existing) {
            // Update existing task (including description)
            ctx.db.updateTask(existing.id, mapped)
            taskId = existing.id
            result.updated++
          } else {
            // Create new task
            const created = ctx.db.createTask({
              ...mapped,
              title: mapped.title || ticket.properties.subject || 'Untitled Ticket',
              source_id: sourceId,
              external_id: ticket.id,
              source: 'HubSpot',
              status: mapped.status || 'not_started'
            })
            if (!created) {
              console.error('[hubspot-plugin] Failed to create task:', ticket.id)
              continue
            }
            taskId = created.id
            result.imported++
          }

          // Download and save attachments
          const hubspotAttachments = await client.getTicketAttachments(ticket.id)
          if (hubspotAttachments.length > 0) {
            await this.downloadAttachments(taskId, hubspotAttachments, client, ctx)
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'
          const ticketTitle = ticket.properties.subject || 'Unknown ticket'
          result.errors.push(`Failed to import "${ticketTitle}": ${errorMsg}`)
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
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) {
      console.log('[hubspot-plugin] Task has no external_id, skipping export')
      return
    }

    // Get access token
    const token = await this.getAccessToken(task.source_id!, config, ctx)
    if (!token) {
      console.error('[hubspot-plugin] No access token, cannot export update')
      return
    }

    const client = new HubSpotClient(token)

    // Handle status change to completed
    if ('status' in changedFields && changedFields.status === 'completed') {
      try {
        // Get pipelines to find a CLOSED stage
        const pipelines = this.pipelineCache.get(task.source_id!) || await client.getPipelines()

        // Get the ticket to find its current pipeline
        const ticket = await client.getTicket(task.external_id)
        if (!ticket) {
          console.error('[hubspot-plugin] Ticket not found in HubSpot')
          return
        }

        // Find the ticket's pipeline
        const ticketPipeline = pipelines.find((p) => p.id === ticket.properties.hs_pipeline)
        if (!ticketPipeline) {
          console.error('[hubspot-plugin] Pipeline not found for ticket')
          return
        }

        // Find the first CLOSED stage in the pipeline
        const closedStage = ticketPipeline.stages.find((s) => s.metadata.ticketState === 'CLOSED')
        if (!closedStage) {
          console.error('[hubspot-plugin] No CLOSED stage found in pipeline')
          return
        }

        // Prepare update payload
        const updatePayload: Record<string, unknown> = {
          hs_pipeline_stage: closedStage.id
        }

        // Add resolution if available
        if (task.resolution) {
          updatePayload.hs_resolution = task.resolution
        }

        // Update ticket to CLOSED stage (with resolution if provided)
        await client.updateTicket(task.external_id, updatePayload)

        console.log(`[hubspot-plugin] Closed HubSpot ticket ${task.external_id}${task.resolution ? ' with resolution' : ''}`)
      } catch (err) {
        console.error('[hubspot-plugin] Failed to close ticket:', err)
      }
    }

    // Handle resolution update
    if ('resolution' in changedFields) {
      try {
        await client.updateTicket(task.external_id, {
          hs_resolution: changedFields.resolution || ''
        })
        console.log(`[hubspot-plugin] Updated resolution for ticket ${task.external_id}`)
      } catch (err) {
        console.error('[hubspot-plugin] Failed to update resolution:', err)
      }
    }

    // Handle assignee change - extract owner ID from assignee string
    // Note: This is a basic implementation. For proper reassignment with owner ID,
    // use the reassignTask method which is called from the UI's reassign flow
    if ('assignee' in changedFields && typeof changedFields.assignee === 'string') {
      try {
        const assigneeDisplay = changedFields.assignee as string
        if (!assigneeDisplay) {
          // Unassign ticket (set owner to null)
          console.log(`[hubspot-plugin] Unassigning ticket ${task.external_id}`)
          await client.updateTicket(task.external_id, {
            hubspot_owner_id: ''
          })
          console.log(`[hubspot-plugin] Unassigned ticket ${task.external_id}`)
        } else {
          // Note: assignee is a display string like "John Doe" or "john@example.com"
          // We can't reliably map it back to a HubSpot owner ID here
          // Use the reassignTask method for proper reassignment
          console.log('[hubspot-plugin] Assignee changed to display string, use reassignTask for proper sync')
        }
      } catch (err) {
        console.error('[hubspot-plugin] Failed to update assignee:', err)
      }
    }
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (!task.source_id || !task.external_id) {
      return { success: false, error: 'Task not linked to HubSpot' }
    }

    try {
      // Get access token
      const token = await this.getAccessToken(task.source_id, config, ctx)
      if (!token) {
        return { success: false, error: 'Authentication failed' }
      }

      const client = new HubSpotClient(token)

      switch (actionId) {
        case 'add_note':
          if (!input) {
            return { success: false, error: 'Note text is required' }
          }
          await client.addTicketNote(task.external_id, input)
          return { success: true }

        case 'update_priority':
          if (!input) {
            return { success: false, error: 'Priority is required' }
          }
          const priority = input.toUpperCase()
          if (!['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
            return { success: false, error: 'Invalid priority. Use: HIGH, MEDIUM, or LOW' }
          }
          await client.updateTicket(task.external_id, {
            hs_ticket_priority: priority
          })
          return {
            success: true,
            taskUpdate: { priority: this.mapPriorityFromHubSpot(priority) }
          }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${errorMsg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<import('../../shared/types').SourceUser[]> {
    if (!ctx.sourceId) {
      console.log('[hubspot-plugin] No source ID, cannot fetch users')
      return []
    }

    try {
      const token = await this.getAccessToken(ctx.sourceId, config, ctx)
      if (!token) {
        console.log('[hubspot-plugin] No access token, cannot fetch users')
        return []
      }

      const client = new HubSpotClient(token)
      const owners = await client.getOwners()

      return owners.map((o) => ({
        id: o.id,
        email: o.email,
        name: `${o.firstName} ${o.lastName}`.trim() || o.email
      }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hubspot-plugin] Failed to fetch users:', errorMsg)
      return []
    }
  }

  async reassignTask(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<import('../../shared/types').ReassignResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task not linked to HubSpot' }
    }

    if (!userIds || userIds.length === 0) {
      return { success: false, error: 'No user IDs provided' }
    }

    try {
      const token = await this.getAccessToken(task.source_id!, config, ctx)
      if (!token) {
        return { success: false, error: 'Authentication failed' }
      }

      const client = new HubSpotClient(token)

      // HubSpot tickets can only have one owner, so use the first user ID
      const ownerId = userIds[0]

      // Update the ticket's owner
      await client.updateTicket(task.external_id, {
        hubspot_owner_id: ownerId
      })

      console.log(`[hubspot-plugin] Reassigned ticket ${task.external_id} to owner ${ownerId}`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hubspot-plugin] Failed to reassign ticket:', errorMsg)
      return { success: false, error: `Reassignment failed: ${errorMsg}` }
    }
  }

  /**
   * Get access token based on auth type (OAuth or Private App)
   */
  private async getAccessToken(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<string | null> {
    const authType = config.auth_type as string

    if (authType === 'oauth') {
      if (!ctx.oauthManager) {
        console.error('[hubspot-plugin] OAuth manager not available')
        return null
      }
      return await ctx.oauthManager.getValidToken(sourceId)
    } else if (authType === 'private_app') {
      // Private app token is stored in config (encrypted in DB)
      return (config.access_token as string) || null
    }

    return null
  }

  /**
   * Map HubSpot ticket to local task format
   */
  private async mapHubSpotTicket(
    ticket: HubSpotTicket,
    ownerName: string,
    contactInfo: string,
    pipelines: HubSpotPipeline[],
    client: HubSpotClient
  ): Promise<Partial<TaskRecord>> {
    // Build rich markdown description
    const parts: string[] = []

    // Original ticket content
    if (ticket.properties.content) {
      parts.push(ticket.properties.content)
      parts.push('')
      parts.push('---')
      parts.push('')
    }

    // Metadata section
    parts.push('## 📋 Ticket Details')
    parts.push('')

    // Add HubSpot status (pipeline and stage)
    if (ticket.properties.hs_pipeline_stage) {
      // Find the pipeline and stage to get human-readable labels
      let statusDisplay = ticket.properties.hs_pipeline_stage
      for (const pipeline of pipelines) {
        const stage = pipeline.stages.find((s) => s.id === ticket.properties.hs_pipeline_stage)
        if (stage) {
          statusDisplay = `${pipeline.label} → ${stage.label}`
          break
        }
      }
      parts.push(`**Status:** ${statusDisplay}`)
    }

    if (contactInfo) {
      parts.push(`**Contact:** ${contactInfo}`)
    }

    if (ticket.properties.createdate) {
      const created = new Date(ticket.properties.createdate)
      parts.push(`**Created:** ${created.toLocaleString()}`)
    }

    if (ticket.properties.hs_lastmodifieddate) {
      const modified = new Date(ticket.properties.hs_lastmodifieddate)
      parts.push(`**Last Modified:** ${modified.toLocaleString()}`)
    }

    if (ticket.properties.hs_ticket_category) {
      parts.push(`**Category:** ${ticket.properties.hs_ticket_category}`)
    }

    // Add link to HubSpot ticket with correct URL from account info
    parts.push('')
    parts.push('---')
    parts.push('')
    const ticketUrl = await client.getTicketUrl(ticket.id)
    parts.push(`🔗 [View in HubSpot](${ticketUrl})`)

    const description = parts.join('\n')

    return {
      title: ticket.properties.subject || 'Untitled Ticket',
      description,
      status: this.mapStatusFromHubSpot(ticket.properties.hs_pipeline_stage, pipelines),
      priority: this.mapPriorityFromHubSpot(ticket.properties.hs_ticket_priority || 'MEDIUM'),
      assignee: ownerName || '',
      due_date: ticket.properties.hs_due_date || null,
      labels: ticket.properties.hs_ticket_category ? [ticket.properties.hs_ticket_category] : [],
      resolution: ticket.properties.hs_resolution || null
    }
  }

  /**
   * Map HubSpot ticket stage to local status
   * Uses pipeline metadata to determine if stage is OPEN or CLOSED
   */
  private mapStatusFromHubSpot(stageId: string | undefined, pipelines: HubSpotPipeline[]): string {
    if (!stageId) return 'not_started'

    // Find the stage in pipelines to get its metadata
    for (const pipeline of pipelines) {
      const stage = pipeline.stages.find((s) => s.id === stageId)
      if (stage) {
        // Use HubSpot's ticketState metadata
        if (stage.metadata.ticketState === 'CLOSED') {
          return 'completed'
        }
        // For OPEN tickets, check stage label for hints
        const label = stage.label.toLowerCase()
        if (label.includes('waiting') || label.includes('new')) {
          return 'not_started'
        }
        if (label.includes('progress') || label.includes('working')) {
          return 'agent_working'
        }
        // Default to agent_working for open tickets
        return 'agent_working'
      }
    }

    // Fallback: check stage ID for common patterns
    const lowerStageId = stageId.toLowerCase()
    if (lowerStageId.includes('closed') || lowerStageId.includes('done')) {
      return 'completed'
    }
    if (lowerStageId.includes('new') || lowerStageId.includes('waiting')) {
      return 'not_started'
    }

    // Default
    return 'agent_working'
  }

  /**
   * Map HubSpot priority to local priority
   * HubSpot: HIGH, MEDIUM, LOW
   */
  private mapPriorityFromHubSpot(hubspotPriority: string): string {
    const priorityMap: Record<string, string> = {
      HIGH: 'high',
      MEDIUM: 'medium',
      LOW: 'low'
    }
    return priorityMap[hubspotPriority] || 'medium'
  }

  /**
   * Download and save HubSpot attachments locally
   */
  private async downloadAttachments(
    taskId: string,
    attachments: Array<{ id: string; name: string; size: number; type: string; url: string; extension?: string }>,
    client: HubSpotClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) {
      console.error(`[hubspot-plugin] Task ${taskId} not found`)
      return
    }

    const existingAttachments = (task.attachments || []) as AttachmentMetadata[]

    // Build set of existing HubSpot file IDs for duplicate detection
    const existingFileIds = new Set(
      existingAttachments
        .map((a) => a.hubspot_file_id)
        .filter((id): id is string => Boolean(id))
    )

    let downloadedCount = 0
    let skippedCount = 0

    for (const attachment of attachments) {
      // Check if already downloaded (by HubSpot file ID, not URL)
      const existingAttachment = existingAttachments.find(
        (a) => a.hubspot_file_id === attachment.id
      )

      if (existingAttachment) {
        // Already downloaded, check if it has a valid extension
        const ext = extname(existingAttachment.filename).toLowerCase()
        const validExtensions = [
          '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
          '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
          '.zip', '.rar', '.7z', '.tar', '.gz',
          '.txt', '.csv', '.json', '.xml', '.html', '.css', '.js',
          '.mp3', '.mp4', '.mov', '.avi'
        ]
        const hasValidExtension = validExtensions.includes(ext)

        if (hasValidExtension) {
          skippedCount++
          continue
        } else {
          // Re-download attachment with invalid/missing extension
          const index = existingAttachments.findIndex((a) => a.hubspot_file_id === attachment.id)
          if (index !== -1) {
            existingAttachments.splice(index, 1)
            existingFileIds.delete(attachment.id)
          }
        }
      }

      try {
        // Download the file
        const buffer = await client.downloadAttachment(attachment.url)

        // Always append extension from HubSpot API (or guess from MIME type)
        let extension = attachment.extension ? `.${attachment.extension}` : ''
        if (!extension) {
          extension = this.guessExtensionFromMimeType(attachment.type)
        }

        const finalFilename = `${attachment.name}${extension}`
        const attachmentId = crypto.randomUUID()

        // Get attachments directory and save file
        const attachmentsDir = ctx.db.getAttachmentsDir(taskId)
        const filePath = join(attachmentsDir, `${attachmentId}-${finalFilename}`)
        writeFileSync(filePath, buffer)

        // Add to task attachments
        const newAttachment = {
          id: attachmentId,
          filename: finalFilename,
          size: buffer.length,
          mime_type: attachment.type || this.guessMimeType(finalFilename),
          added_at: new Date().toISOString(),
          hubspot_file_id: attachment.id,
          hubspot_url: attachment.url
        }

        ctx.db.updateTask(taskId, {
          attachments: [...existingAttachments, newAttachment]
        })

        downloadedCount++
        existingAttachments.push(newAttachment)
        existingFileIds.add(attachment.id)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[hubspot-plugin] Failed to download attachment ${attachment.name}:`, errorMsg)
      }
    }

    if (downloadedCount > 0 || skippedCount > 0) {
      console.log(`[hubspot-plugin] Attachments: ${downloadedCount} downloaded, ${skippedCount} skipped`)
    }
  }

  /**
   * Guess file extension from MIME type
   */
  private guessExtensionFromMimeType(mimeType: string): string {
    const extensionMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/zip': '.zip',
      'text/plain': '.txt',
      'text/csv': '.csv',
      'application/json': '.json'
    }
    return extensionMap[mimeType] || ''
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
}
