/**
 * HubSpot CRM API Client
 *
 * Wraps HubSpot's REST API for ticket management operations.
 * Handles pagination, ticket queries, owners, pipelines, and mutations.
 */

import { Client } from '@hubspot/api-client'

export interface HubSpotTicket {
  id: string
  properties: {
    subject: string
    content?: string
    hs_pipeline?: string
    hs_pipeline_stage?: string
    hs_ticket_priority?: string
    hubspot_owner_id?: string
    hs_due_date?: string
    hs_ticket_category?: string
    hs_resolution?: string
    createdate?: string
    hs_lastmodifieddate?: string
  }
  associations?: {
    contacts?: {
      results: Array<{ id: string }>
    }
  }
}

export interface HubSpotOwner {
  id: string
  email: string
  firstName: string
  lastName: string
}

export interface HubSpotPipeline {
  id: string
  label: string
  displayOrder: number
  stages: Array<{
    id: string
    label: string
    displayOrder: number
    metadata: {
      ticketState: 'OPEN' | 'CLOSED'
    }
  }>
}

export interface HubSpotContact {
  id: string
  properties: {
    firstname?: string
    lastname?: string
    email?: string
  }
}

export interface HubSpotAttachment {
  id: string
  name: string
  size: number
  type: string
  url: string
  extension?: string
}

export interface HubSpotAccountInfo {
  portalId: number
  uiDomain: string
  timeZone: string
  accountType: string
}

const TICKET_PROPERTIES = [
  'subject',
  'content',
  'hs_pipeline',
  'hs_pipeline_stage',
  'hs_ticket_priority',
  'hubspot_owner_id',
  'hs_due_date',
  'hs_ticket_category',
  'hs_resolution',
  'createdate',
  'hs_lastmodifieddate'
]

export class HubSpotClient {
  private client: Client
  private accessToken: string
  private accountInfo?: HubSpotAccountInfo

  constructor(accessToken: string) {
    this.accessToken = accessToken
    this.client = new Client({ accessToken })
  }

  /**
   * Get account information (portal ID and UI domain)
   * Cached after first call
   */
  async getAccountInfo(): Promise<HubSpotAccountInfo> {
    if (this.accountInfo) {
      return this.accountInfo
    }

    try {
      const response = await fetch('https://api.hubapi.com/account-info/v3/details', {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch account info: ${response.status}`)
      }

      const data = await response.json()
      this.accountInfo = {
        portalId: data.portalId,
        uiDomain: data.uiDomain || 'app.hubspot.com',
        timeZone: data.timeZone,
        accountType: data.accountType
      }

      return this.accountInfo
    } catch (err: unknown) {
      throw new Error(`Failed to fetch HubSpot account info: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Build the correct HubSpot ticket URL with region-specific domain and portal ID
   */
  async getTicketUrl(ticketId: string): Promise<string> {
    const accountInfo = await this.getAccountInfo()
    return `https://${accountInfo.uiDomain}/contacts/${accountInfo.portalId}/record/0-5/${ticketId}`
  }

  /**
   * Get all tickets, with optional filters
   * @param pipelineId - Filter by pipeline ID
   * @param ownerId - Filter by owner ID
   * @param modifiedAfter - Only fetch tickets modified after this date (ISO string)
   * @param onlyOpen - Only fetch open tickets (default: false for incremental, true for initial)
   */
  async getTickets(pipelineId?: string, ownerId?: string, modifiedAfter?: string, onlyOpen?: boolean): Promise<HubSpotTicket[]> {
    try {
      let allTickets: HubSpotTicket[] = []

      // If filtering by modified date OR only open tickets, use search API
      if (modifiedAfter || onlyOpen) {
        allTickets = await this.searchTickets(modifiedAfter, pipelineId, ownerId, onlyOpen)
      } else {
        // Otherwise use standard pagination
        let after: string | undefined

        while (true) {
          const response = await this.client.crm.tickets.basicApi.getPage(
            100, // limit (HubSpot max)
            after,
            TICKET_PROPERTIES,
            undefined, // propertiesWithHistory
            ['contacts'] // associations
          )

          allTickets = allTickets.concat(response.results as unknown as HubSpotTicket[])

          if (!response.paging?.next?.after) break
          after = response.paging.next.after
        }

        // Apply filters (client-side)
        if (pipelineId) {
          allTickets = allTickets.filter((t) => t.properties.hs_pipeline === pipelineId)
        }
        if (ownerId) {
          allTickets = allTickets.filter((t) => t.properties.hubspot_owner_id === ownerId)
        }
      }

      console.log(`[HubSpotClient] Fetched ${allTickets.length} tickets`)
      return allTickets
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode: number }).statusCode
        if (statusCode === 401 || statusCode === 403) {
          throw new Error('HubSpot authentication failed. Please re-authenticate.')
        }
      }
      throw new Error(`Failed to fetch HubSpot tickets: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Search tickets using HubSpot Search API with filters
   * @param modifiedAfter - Only fetch tickets modified after this date
   * @param pipelineId - Filter by pipeline ID
   * @param ownerId - Filter by owner ID
   * @param onlyOpen - Only fetch tickets in OPEN state (not CLOSED)
   */
  private async searchTickets(
    modifiedAfter?: string,
    pipelineId?: string,
    ownerId?: string,
    onlyOpen?: boolean
  ): Promise<HubSpotTicket[]> {
    try {
      let allTickets: HubSpotTicket[] = []
      let after: number = 0

      // Build filter groups
      const filters: Array<{ propertyName: string; operator: string; value: string }> = []

      // Add modified date filter if specified
      if (modifiedAfter) {
        filters.push({
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: new Date(modifiedAfter).getTime().toString()
        })
      }

      // Add pipeline filter if specified
      if (pipelineId) {
        filters.push({
          propertyName: 'hs_pipeline',
          operator: 'EQ',
          value: pipelineId
        })
      }

      // Add owner filter if specified
      if (ownerId) {
        filters.push({
          propertyName: 'hubspot_owner_id',
          operator: 'EQ',
          value: ownerId
        })
      }

      const filterGroups = filters.length > 0 ? [{ filters }] : []

      // Fetch all pipelines to filter by OPEN stages
      let openStageIds: string[] = []
      if (onlyOpen) {
        const pipelines = await this.getPipelines()
        // Collect all stage IDs where ticketState is OPEN
        openStageIds = pipelines.flatMap(p =>
          p.stages.filter(s => s.metadata.ticketState === 'OPEN').map(s => s.id)
        )
      }

      // Paginate through search results
      while (true) {
        const searchResponse = await this.client.crm.tickets.searchApi.doSearch({
          filterGroups: filterGroups.length > 0 ? filterGroups as Parameters<typeof this.client.crm.tickets.searchApi.doSearch>[0]['filterGroups'] : undefined,
          properties: TICKET_PROPERTIES,
          limit: 100,
          after: after > 0 ? String(after) : undefined
        })

        let tickets = searchResponse.results as unknown as HubSpotTicket[]

        // Filter by OPEN state client-side (HubSpot doesn't support stage state filtering directly)
        if (onlyOpen && openStageIds.length > 0) {
          tickets = tickets.filter(t => openStageIds.includes(t.properties.hs_pipeline_stage || ''))
        }

        allTickets = allTickets.concat(tickets)

        if (!searchResponse.paging?.next?.after) break
        after = parseInt(searchResponse.paging.next.after)
      }

      return allTickets
    } catch (err: unknown) {
      throw new Error(`Failed to search HubSpot tickets: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Get a single ticket by ID
   */
  async getTicket(ticketId: string): Promise<HubSpotTicket | null> {
    try {
      const response = await this.client.crm.tickets.basicApi.getById(
        ticketId,
        TICKET_PROPERTIES,
        undefined, // propertiesWithHistory
        ['contacts'] // associations
      )

      return response as unknown as HubSpotTicket
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode: number }).statusCode
        if (statusCode === 404) {
          return null
        }
      }
      throw new Error(`Failed to fetch HubSpot ticket: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Update a ticket
   */
  async updateTicket(ticketId: string, updates: Record<string, unknown>): Promise<void> {
    try {
      await this.client.crm.tickets.basicApi.update(ticketId, {
        properties: updates as Record<string, string>
      })
    } catch (err: unknown) {
      throw new Error(`Failed to update HubSpot ticket: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Add a note to a ticket
   */
  async addTicketNote(ticketId: string, noteBody: string): Promise<void> {
    try {
      // Create an engagement (note)
      const noteResponse = await this.client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: new Date().toISOString()
        }
      })

      // Associate the note with the ticket using v4 associations API
      await (this.client.crm.associations.v4.basicApi as { create: (fromType: string, fromId: string, toType: string, toId: string, associations: unknown[]) => Promise<unknown> }).create(
        'tickets',
        ticketId,
        'notes',
        noteResponse.id,
        [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 214 // Ticket to Note association type
          }
        ]
      )
    } catch (err: unknown) {
      throw new Error(`Failed to add note to HubSpot ticket: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Get all owners in the account
   */
  async getOwners(): Promise<HubSpotOwner[]> {
    try {
      const response = await this.client.crm.owners.ownersApi.getPage(undefined, undefined, 100)

      const owners = response.results.map((owner) => ({
        id: owner.id,
        email: owner.email || '',
        firstName: owner.firstName || '',
        lastName: owner.lastName || ''
      }))

      console.log(`[HubSpotClient] Fetched ${owners.length} owners`)
      return owners
    } catch (err: unknown) {
      throw new Error(`Failed to fetch HubSpot owners: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Get a single owner by ID
   */
  async getOwner(ownerId: string): Promise<HubSpotOwner | null> {
    try {
      const response = await this.client.crm.owners.ownersApi.getById(Number(ownerId))

      return {
        id: response.id,
        email: response.email || '',
        firstName: response.firstName || '',
        lastName: response.lastName || ''
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode: number }).statusCode
        if (statusCode === 404) {
          return null
        }
      }
      console.error(`[HubSpotClient] Failed to get owner ${ownerId}:`, err)
      return null
    }
  }

  /**
   * Get all ticket pipelines
   */
  async getPipelines(): Promise<HubSpotPipeline[]> {
    try {
      const response = await this.client.crm.pipelines.pipelinesApi.getAll('tickets')

      const pipelines = response.results.map((pipeline) => ({
        id: pipeline.id,
        label: pipeline.label,
        displayOrder: pipeline.displayOrder,
        stages: (pipeline.stages || []).map((stage) => ({
          id: stage.id,
          label: stage.label,
          displayOrder: stage.displayOrder,
          metadata: stage.metadata as { ticketState: 'OPEN' | 'CLOSED' }
        }))
      }))

      console.log(`[HubSpotClient] Fetched ${pipelines.length} pipelines`)
      return pipelines
    } catch (err: unknown) {
      throw new Error(`Failed to fetch HubSpot pipelines: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Get a contact by ID
   */
  async getContact(contactId: string): Promise<HubSpotContact | null> {
    try {
      const response = await this.client.crm.contacts.basicApi.getById(contactId, [
        'firstname',
        'lastname',
        'email'
      ])

      return response as unknown as HubSpotContact
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode: number }).statusCode
        if (statusCode === 404) {
          return null
        }
      }
      console.error(`[HubSpotClient] Failed to get contact ${contactId}:`, err)
      return null
    }
  }

  /**
   * Get attachments for a ticket
   * Note: In HubSpot, attachments are associated with notes (engagements), not directly with tickets
   */
  async getTicketAttachments(ticketId: string): Promise<HubSpotAttachment[]> {
    try {
      const attachments: HubSpotAttachment[] = []

      // Step 1: Get notes associated with the ticket using v4 associations API
      const notesResponse = await this.client.crm.associations.v4.basicApi.getPage(
        'tickets',
        ticketId,
        'notes'
      )

      if (!notesResponse.results || notesResponse.results.length === 0) {
        return []
      }

      // Step 2: For each note, fetch the note object to get hs_attachment_ids
      for (const noteAssoc of notesResponse.results) {
        try {
          const note = await this.client.crm.objects.notes.basicApi.getById(
            noteAssoc.toObjectId,
            ['hs_attachment_ids']
          )

          // Step 3: Parse attachment IDs from the note
          const attachmentIds = note.properties.hs_attachment_ids
          if (!attachmentIds) continue

          // hs_attachment_ids is a semicolon-separated string
          const ids = attachmentIds.split(';').filter((id) => id.trim())

          // Step 4: Fetch file details for each attachment ID
          for (const attachmentId of ids) {
            try {
              const fileResponse = await this.client.files.filesApi.getById(attachmentId.trim())

              // Get a signed URL for downloading (expires after a short time, but works reliably)
              const signedUrlResponse = await this.client.files.filesApi.getSignedUrl(
                attachmentId.trim(),
                undefined, // size
                300 // expirationSeconds - 5 minutes
              )

              attachments.push({
                id: fileResponse.id,
                name: fileResponse.name || 'Unnamed file',
                size: fileResponse.size || 0,
                type: fileResponse.type || 'application/octet-stream',
                url: signedUrlResponse.url, // Use signed URL instead of redirect URL
                extension: fileResponse.extension || undefined
              })
            } catch (err) {
              console.error(`[HubSpotClient] Failed to fetch attachment ${attachmentId}:`, err)
            }
          }
        } catch (err) {
          console.error(`[HubSpotClient] Failed to fetch note ${noteAssoc.toObjectId}:`, err)
        }
      }

      return attachments
    } catch (err: unknown) {
      console.error(`[HubSpotClient] Failed to get ticket attachments:`, err)
      return []
    }
  }

  /**
   * Download attachment content as buffer
   */
  async downloadAttachment(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } catch (err: unknown) {
      throw new Error(`Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
