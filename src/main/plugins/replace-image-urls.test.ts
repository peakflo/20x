import { describe, it, expect } from 'vitest'
import { replaceRemoteImageUrls } from './replace-image-urls'

describe('replaceRemoteImageUrls', () => {
  const taskId = 'task-123'

  it('returns original markdown when no attachments', () => {
    const md = '![img](https://uploads.linear.app/abc/def/ghi)'
    expect(replaceRemoteImageUrls(md, taskId, [])).toBe(md)
  })

  it('returns original markdown when empty string', () => {
    expect(replaceRemoteImageUrls('', taskId, [{ id: 'a1', filename: 'f.png', linear_url: 'https://x' }])).toBe('')
  })

  it('replaces Linear image URL in markdown image syntax', () => {
    const remoteUrl = 'https://uploads.linear.app/org/team/uuid'
    const md = `Some text\n\n![screenshot](${remoteUrl})\n\nMore text`
    const attachments = [
      { id: 'att-1', filename: 'screenshot.png', linear_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe(`Some text\n\n![screenshot](app-attachment://task-123/att-1)\n\nMore text`)
    expect(result).not.toContain(remoteUrl)
  })

  it('replaces Notion image URL in markdown image syntax', () => {
    const remoteUrl = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def?X-Amz-Signature=xyz'
    const md = `![photo](${remoteUrl})`
    const attachments = [
      { id: 'att-2', filename: 'photo.png', notion_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe('![photo](app-attachment://task-123/att-2)')
  })

  it('replaces HubSpot URL', () => {
    const remoteUrl = 'https://hubspot.com/files/abc123'
    const md = `See: [report](${remoteUrl})`
    const attachments = [
      { id: 'att-3', filename: 'report.pdf', hubspot_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe('See: [report](app-attachment://task-123/att-3)')
  })

  it('replaces multiple URLs in one markdown', () => {
    const url1 = 'https://uploads.linear.app/org/1'
    const url2 = 'https://uploads.linear.app/org/2'
    const md = `![img1](${url1})\n\n![img2](${url2})`
    const attachments = [
      { id: 'a1', filename: 'img1.png', linear_url: url1 },
      { id: 'a2', filename: 'img2.png', linear_url: url2 }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toContain('app-attachment://task-123/a1')
    expect(result).toContain('app-attachment://task-123/a2')
    expect(result).not.toContain(url1)
    expect(result).not.toContain(url2)
  })

  it('replaces duplicate occurrences of the same URL', () => {
    const remoteUrl = 'https://uploads.linear.app/org/team/uuid'
    const md = `![img](${remoteUrl})\n\nAlso here: ${remoteUrl}`
    const attachments = [
      { id: 'att-1', filename: 'screenshot.png', linear_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe('![img](app-attachment://task-123/att-1)\n\nAlso here: app-attachment://task-123/att-1')
  })

  it('does not modify markdown when no URLs match', () => {
    const md = '![img](https://other-domain.com/image.png)'
    const attachments = [
      { id: 'att-1', filename: 'file.png', linear_url: 'https://uploads.linear.app/different' }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe(md)
  })

  it('handles URLs with special regex characters', () => {
    const remoteUrl = 'https://example.com/path?param=val&other=1+2'
    const md = `![img](${remoteUrl})`
    const attachments = [
      { id: 'att-1', filename: 'file.png', notion_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe('![img](app-attachment://task-123/att-1)')
  })

  it('skips attachments without source URL fields', () => {
    const md = '![img](https://uploads.linear.app/org/team/uuid)'
    const attachments = [
      { id: 'att-1', filename: 'manual-file.png' }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe(md)
  })

  it('handles plain URLs (not in markdown syntax)', () => {
    const remoteUrl = 'https://uploads.linear.app/org/file'
    const md = `Check this file: ${remoteUrl}`
    const attachments = [
      { id: 'att-1', filename: 'file.txt', linear_url: remoteUrl }
    ]

    const result = replaceRemoteImageUrls(md, taskId, attachments)
    expect(result).toBe('Check this file: app-attachment://task-123/att-1')
  })
})
