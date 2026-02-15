/**
 * Linear GraphQL API Client
 *
 * Wraps Linear's GraphQL API for task management operations.
 * Handles pagination, issue queries, teams, and mutations.
 */

export interface LinearIssue {
  id: string
  title: string
  description: string
  state: { id: string; name: string }
  team?: { id: string; name: string; key: string }
  priority: number
  assignee?: { id: string; displayName: string }
  dueDate?: string
  labels: { nodes: Array<{ id: string; name: string }> }
  project?: { id: string; name: string }
  attachments: { nodes: Array<{ id: string; url: string; title?: string; subtitle?: string; metadata?: { size?: number } }> }
  comments: { nodes: Array<{ id: string; body: string; user?: { displayName: string }; attachments?: Array<{ id: string; url: string; filename?: string; size?: number; contentType?: string }> }> }
  createdAt: string
  updatedAt: string
}

export interface LinearTeam {
  id: string
  name: string
  key: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  type: string
}

export interface LinearUser {
  id: string
  name: string
  displayName: string
  email: string
}

export interface LinearLabel {
  id: string
  name: string
  color: string
}

export class LinearClient {
  private accessToken: string
  private apiUrl = 'https://api.linear.app/graphql'

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  /**
   * Execute a GraphQL query
   */
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({ query, variables })
    })

    if (!response.ok) {
      const errorText = await response.text()

      // Handle specific error codes
      if (response.status === 401) {
        throw new Error('Linear authentication failed. Please re-authenticate.')
      }
      if (response.status === 403) {
        throw new Error('Linear access forbidden. Check your OAuth permissions.')
      }

      throw new Error(`Linear API error: ${response.status} ${errorText}`)
    }

    const result = await response.json() as { data?: T; errors?: Array<{ message: string }> }

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${result.errors[0].message}`)
    }

    if (!result.data) {
      throw new Error('Linear API returned no data')
    }

    return result.data
  }

  /**
   * Get a single issue by ID
   */
  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query GetIssue($issueId: String!) {
        issue(id: $issueId) {
          id
          title
          description
          state {
            id
            name
          }
          team {
            id
            name
            key
          }
          priority
          assignee {
            id
            displayName
          }
          dueDate
          labels {
            nodes {
              id
              name
            }
          }
          project {
            id
            name
          }
          attachments {
            nodes {
              id
              url
              title
              subtitle
              metadata
            }
          }
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              user {
                displayName
              }
            }
          }
          createdAt
          updatedAt
        }
      }
    `

    const data = await this.query<{ issue: LinearIssue | null }>(query, { issueId })
    return data.issue
  }

  /**
   * Get all issues, optionally filtered by assignee ID
   */
  async getIssues(assigneeId?: string): Promise<LinearIssue[]> {
    // Build filter based on whether assigneeId is provided
    const filterClause = assigneeId ? 'filter: { assignee: { id: { eq: $assigneeId } } }' : ''

    const query = `
      query GetIssues($assigneeId: ID, $first: Int!, $after: String) {
        issues(
          ${filterClause}
          first: $first
          after: $after
          orderBy: updatedAt
        ) {
          nodes {
            id
            title
            description
            state {
              id
              name
            }
            team {
              id
              name
              key
            }
            priority
            assignee {
              id
              displayName
            }
            dueDate
            labels {
              nodes {
                id
                name
              }
            }
            project {
              id
              name
            }
            attachments {
              nodes {
                id
                url
                title
                subtitle
                metadata
              }
            }
            createdAt
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `

    let allIssues: LinearIssue[] = []
    let hasNextPage = true
    let after: string | undefined

    // Paginate through all issues
    while (hasNextPage) {
      const data = await this.query<{
        issues: {
          nodes: LinearIssue[]
          pageInfo: { hasNextPage: boolean; endCursor: string }
        }
      }>(query, { assigneeId: assigneeId || null, first: 50, after })

      allIssues = allIssues.concat(data.issues.nodes)
      hasNextPage = data.issues.pageInfo.hasNextPage
      after = data.issues.pageInfo.endCursor
    }

    return allIssues
  }

  /**
   * Get all teams in the workspace
   */
  async getTeams(): Promise<LinearTeam[]> {
    const query = `
      query GetTeams {
        teams {
          nodes {
            id
            name
            key
          }
        }
      }
    `

    const data = await this.query<{ teams: { nodes: LinearTeam[] } }>(query)
    return data.teams.nodes
  }

  /**
   * Get workflow states for a team
   */
  async getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const query = `
      query GetWorkflowStates($teamId: ID!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }
    `

    const data = await this.query<{
      team: { states: { nodes: LinearWorkflowState[] } }
    }>(query, { teamId })

    return data.team.states.nodes
  }

  /**
   * Get users in the workspace
   */
  async getUsers(): Promise<LinearUser[]> {
    const query = `
      query GetUsers($first: Int!, $after: String) {
        users(first: $first, after: $after) {
          nodes {
            id
            name
            displayName
            email
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `

    let allUsers: LinearUser[] = []
    let hasNextPage = true
    let after: string | undefined

    // Paginate through all users
    while (hasNextPage) {
      const data = await this.query<{
        users: {
          nodes: LinearUser[]
          pageInfo: { hasNextPage: boolean; endCursor: string }
        }
      }>(query, { first: 50, after })

      allUsers = allUsers.concat(data.users.nodes)
      hasNextPage = data.users.pageInfo.hasNextPage
      after = data.users.pageInfo.endCursor
    }

    console.log(`[LinearClient] Fetched ${allUsers.length} users`)
    return allUsers
  }

  /**
   * Update an issue
   */
  async updateIssue(
    issueId: string,
    updates: {
      stateId?: string
      priority?: number
      title?: string
      description?: string
      assigneeId?: string | null
      dueDate?: string | null
    }
  ): Promise<void> {
    const mutation = `
      mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) {
          success
          issue {
            id
          }
        }
      }
    `

    const input: Record<string, unknown> = {}
    if (updates.stateId !== undefined) input.stateId = updates.stateId
    if (updates.priority !== undefined) input.priority = updates.priority
    if (updates.title !== undefined) input.title = updates.title
    if (updates.description !== undefined) input.description = updates.description
    if (updates.assigneeId !== undefined) input.assigneeId = updates.assigneeId
    if (updates.dueDate !== undefined) input.dueDate = updates.dueDate

    const data = await this.query<{
      issueUpdate: { success: boolean }
    }>(mutation, { issueId, input })

    if (!data.issueUpdate.success) {
      throw new Error('Failed to update Linear issue')
    }
  }

  /**
   * Add a comment to an issue
   */
  async addComment(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `

    const data = await this.query<{
      commentCreate: { success: boolean }
    }>(mutation, { issueId, body })

    if (!data.commentCreate.success) {
      throw new Error('Failed to add comment to Linear issue')
    }
  }

  /**
   * Create a new issue
   */
  async createIssue(
    teamId: string,
    title: string,
    description?: string,
    priority?: number,
    assigneeId?: string,
    dueDate?: string
  ): Promise<string> {
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
          }
        }
      }
    `

    const input: Record<string, unknown> = {
      teamId,
      title
    }
    if (description) input.description = description
    if (priority !== undefined) input.priority = priority
    if (assigneeId) input.assigneeId = assigneeId
    if (dueDate) input.dueDate = dueDate

    const data = await this.query<{
      issueCreate: { success: boolean; issue: { id: string } }
    }>(mutation, { input })

    if (!data.issueCreate.success) {
      throw new Error('Failed to create Linear issue')
    }

    return data.issueCreate.issue.id
  }

  /**
   * Get labels for the workspace
   */
  async getLabels(): Promise<LinearLabel[]> {
    const query = `
      query GetLabels {
        issueLabels {
          nodes {
            id
            name
            color
          }
        }
      }
    `

    const data = await this.query<{ issueLabels: { nodes: LinearLabel[] } }>(query)
    return data.issueLabels.nodes
  }

  /**
   * Get attachment metadata by ID
   */
  async getAttachmentMetadata(attachmentId: string): Promise<{ id: string; title?: string; url?: string } | null> {
    const query = `
      query GetAttachment($attachmentId: String!) {
        attachment(id: $attachmentId) {
          id
          title
          url
        }
      }
    `

    try {
      const data = await this.query<{ attachment: { id: string; title?: string; url?: string } | null }>(
        query,
        { attachmentId }
      )
      return data.attachment
    } catch (err) {
      console.error(`[LinearClient] Failed to get attachment metadata for ${attachmentId}:`, err)
      return null
    }
  }

  /**
   * Download an attachment from Linear
   */
  async downloadAttachment(url: string): Promise<{ buffer: Buffer; filename?: string; contentType?: string }> {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    })

    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`)
    }

    // Extract filename from Content-Disposition header
    let filename: string | undefined
    const contentDisposition = response.headers.get('content-disposition')
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '')
      }
    }

    // Get content type
    const contentType = response.headers.get('content-type') || undefined

    const arrayBuffer = await response.arrayBuffer()
    return {
      buffer: Buffer.from(arrayBuffer),
      filename,
      contentType
    }
  }
}
