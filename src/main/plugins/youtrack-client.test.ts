import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YouTrackClient } from './youtrack-client'

// ── Helpers ──────────────────────────────────────────────────

const mockFetch = vi.fn()
global.fetch = mockFetch

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
  } as unknown as Response
}

// ── Tests ────────────────────────────────────────────────────

describe('YouTrackClient', () => {
  let client: YouTrackClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new YouTrackClient('https://youtrack.example.com', 'perm:test-token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor / URL normalization', () => {
    it('strips trailing slash from base URL', () => {
      const c = new YouTrackClient('https://youtrack.example.com/', 'token')
      expect(c.getBaseUrl()).toBe('https://youtrack.example.com')
    })

    it('strips trailing /api from base URL', () => {
      const c = new YouTrackClient('https://youtrack.example.com/api', 'token')
      expect(c.getBaseUrl()).toBe('https://youtrack.example.com')
    })

    it('strips trailing /api/ from base URL', () => {
      const c = new YouTrackClient('https://youtrack.example.com/api/', 'token')
      expect(c.getBaseUrl()).toBe('https://youtrack.example.com')
    })

    it('handles path-based URLs like /youtrack', () => {
      const c = new YouTrackClient('https://server.com/youtrack', 'token')
      expect(c.getBaseUrl()).toBe('https://server.com/youtrack')
    })
  })

  describe('testConnection', () => {
    it('sends GET request with auth header to /api/users/me', async () => {
      const mockUser = { id: '1', login: 'admin', fullName: 'Admin User' }
      mockFetch.mockResolvedValueOnce(jsonResponse(mockUser))

      const result = await client.testConnection()

      expect(result).toEqual(mockUser)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://youtrack.example.com/api/users/me?fields=id,login,fullName,email',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer perm:test-token',
            'Accept': 'application/json'
          })
        })
      )
    })

    it('throws on 401 authentication failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401))
      await expect(client.testConnection()).rejects.toThrow('authentication failed')
    })

    it('throws on 403 forbidden', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403))
      await expect(client.testConnection()).rejects.toThrow('forbidden')
    })

    it('throws on 404 not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
      await expect(client.testConnection()).rejects.toThrow('not found')
    })
  })

  describe('getIssues', () => {
    it('fetches issues with correct query params', async () => {
      const mockIssues = [{ id: 'issue-1', summary: 'Test' }]
      mockFetch.mockResolvedValueOnce(jsonResponse(mockIssues))

      const result = await client.getIssues('project: TEST', 0, 50)

      expect(result).toEqual(mockIssues)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('/api/issues?')
      expect(calledUrl).toContain('query=project%3A+TEST')
      expect(calledUrl).toContain('%24skip=0')
      expect(calledUrl).toContain('%24top=50')
    })
  })

  describe('getAllIssues', () => {
    it('handles single page of results', async () => {
      const issues = Array.from({ length: 10 }, (_, i) => ({
        id: `issue-${i}`,
        summary: `Issue ${i}`
      }))
      mockFetch.mockResolvedValueOnce(jsonResponse(issues))

      const result = await client.getAllIssues('project: TEST')

      expect(result).toHaveLength(10)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('paginates through multiple pages', async () => {
      // First page: 50 results (full page)
      const page1 = Array.from({ length: 50 }, (_, i) => ({
        id: `issue-${i}`,
        summary: `Issue ${i}`
      }))
      // Second page: 10 results (partial page = last page)
      const page2 = Array.from({ length: 10 }, (_, i) => ({
        id: `issue-${50 + i}`,
        summary: `Issue ${50 + i}`
      }))

      mockFetch
        .mockResolvedValueOnce(jsonResponse(page1))
        .mockResolvedValueOnce(jsonResponse(page2))

      const result = await client.getAllIssues('project: TEST')

      expect(result).toHaveLength(60)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Verify skip parameter increments
      const firstUrl = mockFetch.mock.calls[0][0] as string
      const secondUrl = mockFetch.mock.calls[1][0] as string
      expect(firstUrl).toContain('%24skip=0')
      expect(secondUrl).toContain('%24skip=50')
    })
  })

  describe('updateIssue', () => {
    it('sends POST with body to update issue', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'issue-1' }))

      await client.updateIssue('issue-1', { summary: 'Updated Title' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/issues/issue-1'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ summary: 'Updated Title' })
        })
      )
    })
  })

  describe('addComment', () => {
    it('sends POST to add comment', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'comment-1' }))

      await client.addComment('issue-1', 'Hello world')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/issues/issue-1/comments'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Hello world' })
        })
      )
    })
  })

  describe('getProjects', () => {
    it('fetches projects from admin API', async () => {
      const projects = [{ id: '1', name: 'Project', shortName: 'PRJ' }]
      mockFetch.mockResolvedValueOnce(jsonResponse(projects))

      const result = await client.getProjects()

      expect(result).toEqual(projects)
      expect(mockFetch.mock.calls[0][0]).toContain('/api/admin/projects')
    })
  })

  describe('getUsers', () => {
    it('fetches users with correct fields', async () => {
      const users = [{ id: '1', login: 'admin', fullName: 'Admin' }]
      mockFetch.mockResolvedValueOnce(jsonResponse(users))

      const result = await client.getUsers()

      expect(result).toEqual(users)
      expect(mockFetch.mock.calls[0][0]).toContain('/api/users')
    })
  })

  describe('downloadAttachment', () => {
    it('downloads attachment with auth header', async () => {
      const buffer = new ArrayBuffer(4)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="test.png"'
        }),
        arrayBuffer: () => Promise.resolve(buffer)
      } as unknown as Response)

      const result = await client.downloadAttachment('/api/files/test.png')

      expect(result.filename).toBe('test.png')
      expect(result.contentType).toBe('image/png')
      // Verify Bearer auth was sent
      expect(mockFetch).toHaveBeenCalledWith(
        'https://youtrack.example.com/api/files/test.png',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer perm:test-token'
          })
        })
      )
    })

    it('handles absolute attachment URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
      } as unknown as Response)

      await client.downloadAttachment('https://cdn.example.com/file.pdf')

      expect(mockFetch.mock.calls[0][0]).toBe('https://cdn.example.com/file.pdf')
    })

    it('throws on download failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers()
      } as unknown as Response)

      await expect(client.downloadAttachment('/api/files/missing.txt'))
        .rejects.toThrow('Failed to download attachment')
    })
  })

  describe('rate limiting / retries', () => {
    it('retries on 429 with Retry-After header', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '1' }),
          text: () => Promise.resolve('Rate limited')
        } as unknown as Response)
        .mockResolvedValueOnce(jsonResponse({ id: '1', login: 'admin', fullName: 'Admin' }))

      const result = await client.testConnection()

      expect(result).toEqual({ id: '1', login: 'admin', fullName: 'Admin' })
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })
})
