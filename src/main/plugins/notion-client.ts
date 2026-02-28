/**
 * Notion REST API Client
 *
 * Lightweight client using fetch() — no npm dependencies.
 * Handles pagination, rate limiting, and error handling.
 */

// ── Response types ───────────────────────────────────────────

export interface NotionDatabase {
  id: string
  title: Array<{ plain_text: string }>
  properties: Record<string, NotionPropertySchema>
}

export interface NotionPropertySchema {
  id: string
  name: string
  type: string
  status?: { options: Array<{ id: string; name: string; color: string }>; groups: Array<{ id: string; name: string; option_ids: string[] }> }
  select?: { options: Array<{ id: string; name: string; color: string }> }
  multi_select?: { options: Array<{ id: string; name: string; color: string }> }
}

export interface NotionPage {
  id: string
  archived: boolean
  properties: Record<string, NotionPropertyValue>
  url: string
  last_edited_time: string
  created_time: string
}

export interface NotionPropertyValue {
  id: string
  type: string
  title?: Array<{ plain_text: string }>
  rich_text?: Array<{ plain_text: string }>
  status?: { id: string; name: string } | null
  select?: { id: string; name: string } | null
  multi_select?: Array<{ id: string; name: string }>
  people?: Array<{ id: string; name?: string; person?: { email?: string } }>
  date?: { start: string; end?: string | null } | null
  number?: number | null
  checkbox?: boolean
  url?: string | null
}

export interface NotionUser {
  id: string
  type: string
  name?: string
  person?: { email?: string }
}

export interface NotionBlock {
  id: string
  type: string
  has_children: boolean
  _children?: NotionBlock[]
  [key: string]: unknown
}

// ── Filter types ─────────────────────────────────────────────

export type NotionFilter =
  | NotionCompoundFilter
  | NotionPropertyFilter
  | NotionTimestampFilter

export interface NotionCompoundFilter {
  and?: NotionFilter[]
  or?: NotionFilter[]
}

export interface NotionPropertyFilter {
  property: string
  [key: string]: unknown
}

export interface NotionTimestampFilter {
  timestamp: string
  last_edited_time?: { on_or_after: string }
}

// ── Client ───────────────────────────────────────────────────

const NOTION_API = 'https://api.notion.com'
const NOTION_VERSION = '2022-06-28'
const RATE_LIMIT_DELAY = 350 // ms between paginated requests

export class NotionClient {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  // ── Private helpers ──────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retries = 3
  ): Promise<T> {
    const url = `${NOTION_API}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })

    if (response.status === 401) {
      throw new Error('Notion authentication failed. Check your integration token.')
    }
    if (response.status === 403) {
      throw new Error('Notion access forbidden. Make sure the database is shared with your integration.')
    }
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10)
      await this.sleep(retryAfter * 1000)
      return this.request(method, path, body, retries - 1)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Notion API error: ${response.status} ${errorText}`)
    }

    return response.json() as Promise<T>
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ── Public methods ───────────────────────────────────────

  /**
   * List databases accessible to the integration
   */
  async searchDatabases(): Promise<NotionDatabase[]> {
    const results: NotionDatabase[] = []
    let startCursor: string | undefined

    do {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'database' },
        page_size: 100
      }
      if (startCursor) body.start_cursor = startCursor

      const data = await this.request<{
        results: NotionDatabase[]
        has_more: boolean
        next_cursor: string | null
      }>('POST', '/v1/search', body)

      results.push(...data.results)
      startCursor = data.has_more && data.next_cursor ? data.next_cursor : undefined

      if (startCursor) await this.sleep(RATE_LIMIT_DELAY)
    } while (startCursor)

    return results
  }

  /**
   * Get a database schema (property definitions)
   */
  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request<NotionDatabase>('GET', `/v1/databases/${databaseId}`)
  }

  /**
   * Query all pages from a database with optional filters and incremental sync
   */
  async queryAllPages(
    databaseId: string,
    filter?: NotionFilter,
    lastSyncedAt?: string | null
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = []
    let startCursor: string | undefined

    // Build the combined filter (flatten to avoid >2 nesting levels)
    const andClauses: NotionFilter[] = []
    if (filter) {
      // If the user filter is already an AND, flatten its clauses
      const compound = filter as NotionCompoundFilter
      if (compound.and) {
        andClauses.push(...compound.and)
      } else {
        andClauses.push(filter)
      }
    }
    if (lastSyncedAt) {
      andClauses.push({
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: lastSyncedAt }
      })
    }

    const combinedFilter: NotionFilter | undefined =
      andClauses.length === 0 ? undefined :
      andClauses.length === 1 ? andClauses[0] :
      { and: andClauses }

    console.log('[Notion] Query filter:', JSON.stringify(combinedFilter, null, 2))

    do {
      const body: Record<string, unknown> = { page_size: 100 }
      if (combinedFilter) body.filter = combinedFilter
      if (startCursor) body.start_cursor = startCursor

      const data = await this.request<{
        results: NotionPage[]
        has_more: boolean
        next_cursor: string | null
      }>('POST', `/v1/databases/${databaseId}/query`, body)

      pages.push(...data.results)
      startCursor = data.has_more && data.next_cursor ? data.next_cursor : undefined

      if (startCursor) await this.sleep(RATE_LIMIT_DELAY)
    } while (startCursor)

    return pages
  }

  /**
   * Get page content (blocks) and convert to markdown.
   * Recursively fetches children for toggle, callout, and other container blocks.
   */
  async getPageContent(pageId: string, maxDepth = 3): Promise<string> {
    const blocks = await this.fetchBlocks(pageId)

    // Recursively fetch children for blocks that have them
    if (maxDepth > 0) {
      for (const block of blocks) {
        if (block.has_children) {
          block._children = await this.fetchBlocks(block.id)
          // One more level for nested children
          if (maxDepth > 1) {
            for (const child of block._children) {
              if (child.has_children) {
                child._children = await this.fetchBlocks(child.id)
              }
            }
          }
        }
      }
    }

    return this.blocksToMarkdown(blocks)
  }

  /**
   * Fetch all child blocks for a given block/page ID
   */
  private async fetchBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = []
    let startCursor: string | undefined

    do {
      const path = `/v1/blocks/${blockId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`
      const data = await this.request<{
        results: NotionBlock[]
        has_more: boolean
        next_cursor: string | null
      }>('GET', path)

      blocks.push(...data.results)
      startCursor = data.has_more && data.next_cursor ? data.next_cursor : undefined

      if (startCursor) await this.sleep(RATE_LIMIT_DELAY)
    } while (startCursor)

    return blocks
  }

  /**
   * Update a page's properties
   */
  async updatePage(
    pageId: string,
    properties: Record<string, unknown>
  ): Promise<NotionPage> {
    return this.request<NotionPage>('PATCH', `/v1/pages/${pageId}`, { properties })
  }

  /**
   * List workspace users
   */
  async getUsers(): Promise<NotionUser[]> {
    const users: NotionUser[] = []
    let startCursor: string | undefined

    do {
      const path = `/v1/users?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`
      const data = await this.request<{
        results: NotionUser[]
        has_more: boolean
        next_cursor: string | null
      }>('GET', path)

      users.push(...data.results)
      startCursor = data.has_more && data.next_cursor ? data.next_cursor : undefined

      if (startCursor) await this.sleep(RATE_LIMIT_DELAY)
    } while (startCursor)

    return users
  }

  // ── Block → Markdown conversion ──────────────────────────

  private blocksToMarkdown(blocks: NotionBlock[], indent = ''): string {
    const lines: string[] = []

    for (const block of blocks) {
      const text = this.extractRichText(block)
      const children = block._children

      switch (block.type) {
        case 'paragraph':
          lines.push(indent + text)
          break
        case 'heading_1':
          lines.push(`${indent}# ${text}`)
          break
        case 'heading_2':
          lines.push(`${indent}## ${text}`)
          break
        case 'heading_3':
          lines.push(`${indent}### ${text}`)
          break
        case 'bulleted_list_item':
          lines.push(`${indent}- ${text}`)
          break
        case 'numbered_list_item':
          lines.push(`${indent}1. ${text}`)
          break
        case 'to_do': {
          const checked = (block as Record<string, unknown>).to_do &&
            ((block as Record<string, { checked?: boolean }>).to_do?.checked ? 'x' : ' ')
          lines.push(`${indent}- [${checked}] ${text}`)
          break
        }
        case 'toggle':
          // Render as bold heading + children content (no HTML tags)
          lines.push(`${indent}**${text}**`)
          break
        case 'code': {
          const lang = (block as Record<string, { language?: string }>).code?.language || ''
          lines.push(`${indent}\`\`\`${lang}\n${text}\n\`\`\``)
          break
        }
        case 'quote':
          lines.push(`${indent}> ${text}`)
          break
        case 'divider':
          lines.push(`${indent}---`)
          break
        case 'callout':
          lines.push(`${indent}> ${text}`)
          break
        default:
          if (text) lines.push(indent + text)
      }

      // Render children content (for toggles, callouts, etc.)
      if (children && children.length > 0) {
        lines.push(this.blocksToMarkdown(children, indent))
      }
    }

    return lines.join('\n\n')
  }

  private extractRichText(block: NotionBlock): string {
    const blockData = block[block.type] as { rich_text?: Array<{ plain_text: string }> } | undefined
    if (!blockData?.rich_text) return ''
    return blockData.rich_text.map((t) => t.plain_text).join('')
  }
}
