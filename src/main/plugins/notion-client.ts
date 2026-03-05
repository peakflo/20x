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

export interface NotionFileObject {
  name: string
  type: 'file' | 'external'
  file?: { url: string; expiry_time?: string }
  external?: { url: string }
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
  unique_id?: { prefix: string | null; number: number } | null
  files?: NotionFileObject[]
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
    const blocks = await this.fetchBlocksRecursive(pageId, maxDepth)
    return this.blocksToMarkdown(blocks)
  }

  /**
   * Get page blocks with recursive children fetching.
   * Returns the raw block tree for both markdown rendering and file extraction.
   */
  async getPageBlocks(pageId: string, maxDepth = 3): Promise<NotionBlock[]> {
    return this.fetchBlocksRecursive(pageId, maxDepth)
  }

  /**
   * Fetch blocks and recursively fetch their children up to maxDepth.
   */
  private async fetchBlocksRecursive(blockId: string, maxDepth: number): Promise<NotionBlock[]> {
    const blocks = await this.fetchBlocks(blockId)

    if (maxDepth > 0) {
      for (const block of blocks) {
        if (block.has_children) {
          block._children = await this.fetchBlocks(block.id)
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

    return blocks
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

  /**
   * Download a file from a URL (Notion-hosted or external).
   * Returns the buffer, detected filename, and content type.
   */
  async downloadFile(url: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream'

    // Try to extract filename from Content-Disposition header
    let filename = ''
    const disposition = response.headers.get('content-disposition')
    if (disposition) {
      const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/)
      if (match) filename = decodeURIComponent(match[1].replace(/"/g, ''))
    }

    // Fallback: extract from URL path
    if (!filename) {
      try {
        const urlObj = new URL(url)
        const pathParts = urlObj.pathname.split('/').filter(Boolean)
        const lastPart = pathParts[pathParts.length - 1]
        if (lastPart && lastPart.includes('.')) {
          filename = decodeURIComponent(lastPart)
        }
      } catch {
        // ignore
      }
    }

    if (!filename) {
      filename = `notion-file-${Date.now()}`
    }

    const arrayBuffer = await response.arrayBuffer()
    return { buffer: Buffer.from(arrayBuffer), filename, contentType }
  }

  /**
   * Extract file URLs from page blocks (images, files, PDFs, videos, audio).
   * Returns array of { url, filename } for downloadable files.
   */
  extractFilesFromBlocks(blocks: NotionBlock[]): Array<{ url: string; filename: string }> {
    const files: Array<{ url: string; filename: string }> = []

    for (const block of blocks) {
      const fileInfo = this.extractFileFromBlock(block)
      if (fileInfo) files.push(fileInfo)

      // Recurse into children
      if (block._children && block._children.length > 0) {
        files.push(...this.extractFilesFromBlocks(block._children))
      }
    }

    // Deduplicate by URL
    const seen = new Set<string>()
    return files.filter(f => {
      if (seen.has(f.url)) return false
      seen.add(f.url)
      return true
    })
  }

  /**
   * Extract file URL from a single block (image, file, pdf, video, audio)
   */
  private extractFileFromBlock(block: NotionBlock): { url: string; filename: string } | null {
    const fileBlockTypes = ['image', 'file', 'pdf', 'video', 'audio']
    if (!fileBlockTypes.includes(block.type)) return null

    const blockData = block[block.type] as {
      type?: 'file' | 'external'
      file?: { url: string }
      external?: { url: string }
      caption?: Array<{ plain_text: string }>
      name?: string
    } | undefined

    if (!blockData) return null

    let url: string | undefined
    if (blockData.type === 'file' && blockData.file?.url) {
      url = blockData.file.url
    } else if (blockData.type === 'external' && blockData.external?.url) {
      url = blockData.external.url
    }

    if (!url) return null

    // Determine filename: prefer caption, then name, then derive from URL
    let filename = ''
    if (blockData.caption && blockData.caption.length > 0) {
      const captionText = blockData.caption.map(t => t.plain_text).join('').trim()
      if (captionText) filename = captionText
    }
    if (!filename && blockData.name) {
      filename = blockData.name
    }
    if (!filename) {
      try {
        const urlObj = new URL(url)
        const pathParts = urlObj.pathname.split('/').filter(Boolean)
        const lastPart = pathParts[pathParts.length - 1]
        if (lastPart && lastPart.includes('.')) {
          filename = decodeURIComponent(lastPart)
        }
      } catch {
        // ignore
      }
    }
    if (!filename) {
      filename = `notion-${block.type}-${block.id.slice(0, 8)}`
    }

    return { url, filename }
  }

  /**
   * Extract file URLs from a Files property value.
   */
  extractFilesFromProperty(files: NotionFileObject[]): Array<{ url: string; filename: string }> {
    return files.map(f => {
      const url = f.type === 'file' ? f.file?.url : f.external?.url
      if (!url) return null
      return { url, filename: f.name || `notion-file-${Date.now()}` }
    }).filter((f): f is { url: string; filename: string } => f !== null)
  }

  // ── Block → Markdown conversion ──────────────────────────

  blocksToMarkdown(blocks: NotionBlock[], indent = ''): string {
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
        case 'image': {
          const imgData = block.image as { type?: string; file?: { url: string }; external?: { url: string }; caption?: Array<{ plain_text: string }> } | undefined
          const imgUrl = imgData?.type === 'file' ? imgData.file?.url : imgData?.external?.url
          const imgCaption = imgData?.caption?.map(t => t.plain_text).join('') || 'image'
          if (imgUrl) lines.push(`${indent}![${imgCaption}](${imgUrl})`)
          break
        }
        case 'file':
        case 'pdf':
        case 'video':
        case 'audio': {
          const fileData = block[block.type] as { type?: string; file?: { url: string }; external?: { url: string }; caption?: Array<{ plain_text: string }>; name?: string } | undefined
          const fileUrl = fileData?.type === 'file' ? fileData.file?.url : fileData?.external?.url
          const fileCaption = fileData?.caption?.map(t => t.plain_text).join('') || fileData?.name || block.type
          if (fileUrl) lines.push(`${indent}📎 [${fileCaption}](${fileUrl})`)
          break
        }
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
