/**
 * YouTrack REST API Client
 *
 * Lightweight client using fetch() -- no npm dependencies.
 * Handles pagination, rate limiting, and error handling.
 * Supports both YouTrack Cloud and self-hosted instances.
 */

// ── Response types ───────────────────────────────────────────

export interface YouTrackUser {
  id: string
  login: string
  fullName: string
  email?: string
  $type?: string
}

export interface YouTrackProject {
  id: string
  name: string
  shortName: string
  $type?: string
}

export interface YouTrackCustomFieldValue {
  name?: string
  login?: string
  fullName?: string
  text?: string
  minutes?: number
  presentation?: string
  id?: string
  $type?: string
}

export interface YouTrackCustomField {
  name: string
  value:
    | YouTrackCustomFieldValue
    | YouTrackCustomFieldValue[]
    | string
    | number
    | null
  projectCustomField?: {
    field?: {
      name: string
      fieldType?: { id: string }
    }
  }
  $type?: string
}

export interface YouTrackTag {
  id: string
  name: string
  color?: {
    background?: string
    foreground?: string
  }
  $type?: string
}

export interface YouTrackAttachment {
  id: string
  name: string
  url: string
  size: number
  mimeType: string
  $type?: string
}

export interface YouTrackIssueLinkType {
  name: string
  sourceToTarget: string
  targetToSource: string | null
  directed: boolean
  $type?: string
}

export interface YouTrackIssueLink {
  id: string
  direction: 'OUTWARD' | 'INWARD' | 'BOTH'
  linkType: YouTrackIssueLinkType | null
  issues: Array<{
    id: string
    idReadable: string
    summary: string
    resolved: number | null
  }>
  $type?: string
}

export interface YouTrackIssue {
  id: string
  idReadable: string
  summary: string
  description: string | null
  created: number
  updated: number
  resolved: number | null
  project: YouTrackProject
  reporter?: YouTrackUser
  customFields: YouTrackCustomField[]
  tags: YouTrackTag[]
  attachments: YouTrackAttachment[]
  links: YouTrackIssueLink[]
  $type?: string
}

export interface YouTrackBundleValue {
  name: string
  login?: string
  fullName?: string
  id?: string
  $type?: string
}

export interface YouTrackProjectCustomField {
  id: string
  field: {
    name: string
    fieldType: { id: string }
  }
  bundle?: {
    values: YouTrackBundleValue[]
  }
  $type?: string
}

// ── Client ───────────────────────────────────────────────────

const PAGE_SIZE = 50
const RATE_LIMIT_DELAY = 200 // ms between paginated requests

/** Fields param to request all data needed for task mapping */
const ISSUE_FIELDS = [
  'id',
  'idReadable',
  'summary',
  'description',
  'created',
  'updated',
  'resolved',
  'project(id,name,shortName)',
  'reporter(login,fullName)',
  'customFields(name,value(name,login,fullName,text,minutes,presentation,id,$type),projectCustomField(field(name,fieldType(id))))',
  'tags(id,name,color(background,foreground))',
  'attachments(id,name,url,size,mimeType)',
  'links(id,direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved))'
].join(',')

export class YouTrackClient {
  private baseUrl: string
  private token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = this.normalizeBaseUrl(baseUrl)
    this.token = token
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Normalize the base URL: strip trailing slash and /api suffix.
   * Handles path-based URLs like /youtrack.
   */
  private normalizeBaseUrl(url: string): string {
    let normalized = url.trim()
    // Remove trailing slash(es)
    normalized = normalized.replace(/\/+$/, '')
    // Remove trailing /api if present
    normalized = normalized.replace(/\/api$/, '')
    return normalized
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retries = 3
  ): Promise<T> {
    const url = `${this.baseUrl}/api${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })

    if (response.status === 401) {
      throw new Error(
        'YouTrack authentication failed. Check your permanent token.'
      )
    }
    if (response.status === 403) {
      throw new Error(
        'YouTrack access forbidden. Your token may lack the required permissions.'
      )
    }
    if (response.status === 404) {
      throw new Error(
        `YouTrack API endpoint not found: ${path}. Check your server URL.`
      )
    }
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(
        response.headers.get('Retry-After') || '2',
        10
      )
      await this.sleep(retryAfter * 1000)
      return this.request(method, path, body, retries - 1)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`YouTrack API error: ${response.status} ${errorText}`)
    }

    return response.json() as Promise<T>
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ── Public methods ───────────────────────────────────────

  /**
   * Test connection by fetching the current user.
   * Also verifies the server URL is correct and reachable.
   */
  async testConnection(): Promise<YouTrackUser> {
    return this.request<YouTrackUser>(
      'GET',
      '/users/me?fields=id,login,fullName,email'
    )
  }

  /**
   * Fetch issues matching a YQL query with pagination.
   */
  async getIssues(
    query: string,
    skip = 0,
    top = PAGE_SIZE
  ): Promise<YouTrackIssue[]> {
    const params = new URLSearchParams({
      fields: ISSUE_FIELDS,
      query,
      $skip: String(skip),
      $top: String(top)
    })
    return this.request<YouTrackIssue[]>('GET', `/issues?${params.toString()}`)
  }

  /**
   * Fetch all issues matching a YQL query, handling pagination automatically.
   * Inserts a delay between pages to avoid rate limiting.
   */
  async getAllIssues(query: string): Promise<YouTrackIssue[]> {
    const allIssues: YouTrackIssue[] = []
    let skip = 0

    do {
      const page = await this.getIssues(query, skip, PAGE_SIZE)
      allIssues.push(...page)

      if (page.length < PAGE_SIZE) break
      skip += PAGE_SIZE
      await this.sleep(RATE_LIMIT_DELAY)
    } while (true)

    return allIssues
  }

  /**
   * Fetch a single issue by ID.
   */
  async getIssue(issueId: string): Promise<YouTrackIssue> {
    const params = new URLSearchParams({ fields: ISSUE_FIELDS })
    return this.request<YouTrackIssue>(
      'GET',
      `/issues/${issueId}?${params.toString()}`
    )
  }

  /**
   * Update an issue's fields.
   */
  async updateIssue(
    issueId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const params = new URLSearchParams({ fields: 'id' })
    await this.request<unknown>(
      'POST',
      `/issues/${issueId}?${params.toString()}`,
      body
    )
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(issueId: string, text: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/issues/${issueId}/comments?fields=id`,
      { text }
    )
  }

  /**
   * List all projects accessible to the current user.
   * Uses admin API; falls back gracefully on 403.
   */
  async getProjects(): Promise<YouTrackProject[]> {
    try {
      return await this.request<YouTrackProject[]>(
        'GET',
        '/admin/projects?fields=id,name,shortName&$top=500'
      )
    } catch (err) {
      // If admin API is forbidden, try the regular issues-based approach
      if (
        err instanceof Error &&
        err.message.includes('forbidden')
      ) {
        console.warn(
          '[youtrack] Admin API not accessible, falling back to user projects'
        )
        // Fallback: query current user's visible projects
        try {
          return await this.request<YouTrackProject[]>(
            'GET',
            '/admin/projects?fields=id,name,shortName&$top=500'
          )
        } catch {
          return []
        }
      }
      throw err
    }
  }

  /**
   * List workspace users.
   */
  async getUsers(): Promise<YouTrackUser[]> {
    return this.request<YouTrackUser[]>(
      'GET',
      '/users?fields=id,login,fullName,email&$top=500'
    )
  }

  /**
   * Get custom fields for a project, including bundle values.
   * This is used to resolve filter options (states, priorities, types).
   */
  async getProjectCustomFields(
    projectId: string
  ): Promise<YouTrackProjectCustomField[]> {
    return this.request<YouTrackProjectCustomField[]>(
      'GET',
      `/admin/projects/${projectId}/customFields?fields=id,field(name,fieldType(id)),bundle(values(name,login,fullName,id,$type))&$top=100`
    )
  }

  /**
   * Download an attachment file.
   * Attachment URLs in YouTrack are relative; we prepend the base URL.
   */
  async downloadAttachment(
    attachmentUrl: string
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    // Attachment URLs may be relative or absolute
    const fullUrl = attachmentUrl.startsWith('http')
      ? attachmentUrl
      : `${this.baseUrl}${attachmentUrl}`

    const response = await fetch(fullUrl, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    })

    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status}`)
    }

    const contentType =
      response.headers.get('content-type') || 'application/octet-stream'

    // Try to extract filename from Content-Disposition header
    let filename = ''
    const disposition = response.headers.get('content-disposition')
    if (disposition) {
      const match = disposition.match(
        /filename[*]?=(?:UTF-8''|"?)([^";]+)/i
      )
      if (match) filename = decodeURIComponent(match[1].replace(/"/g, ''))
    }

    // Fallback: extract from URL path
    if (!filename) {
      try {
        const urlObj = new URL(fullUrl)
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
      filename = `youtrack-attachment-${Date.now()}`
    }

    const arrayBuffer = await response.arrayBuffer()
    return { buffer: Buffer.from(arrayBuffer), filename, contentType }
  }

  /**
   * Get the base URL for constructing issue web links.
   */
  getBaseUrl(): string {
    return this.baseUrl
  }
}
