import { describe, it, expect } from 'vitest'
import { normalizeUrlForComparison, buildNormalizedUrlSet } from './url-utils'

describe('normalizeUrlForComparison', () => {
  it('strips query parameters from a URL', () => {
    const url = 'https://uploads.linear.app/org/team/file-id?signature=abc123&expires=999'
    expect(normalizeUrlForComparison(url)).toBe(
      'https://uploads.linear.app/org/team/file-id'
    )
  })

  it('strips query parameters from Notion S3 URLs', () => {
    const url =
      'https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/block/image.png?X-Amz-Algorithm=AWS4&X-Amz-Credential=xxx&X-Amz-Expires=3600'
    expect(normalizeUrlForComparison(url)).toBe(
      'https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/block/image.png'
    )
  })

  it('returns the same URL if it has no query params', () => {
    const url = 'https://example.com/path/to/file.png'
    expect(normalizeUrlForComparison(url)).toBe(url)
  })

  it('returns the original string for invalid URLs', () => {
    expect(normalizeUrlForComparison('not-a-url')).toBe('not-a-url')
  })

  it('strips fragment identifiers as well', () => {
    const url = 'https://example.com/file.png?token=abc#section'
    expect(normalizeUrlForComparison(url)).toBe('https://example.com/file.png')
  })
})

describe('buildNormalizedUrlSet', () => {
  it('builds a set of normalized URLs from attachment records', () => {
    const attachments = [
      { id: '1', linear_url: 'https://uploads.linear.app/a/b/c?sig=old-token' },
      { id: '2', linear_url: 'https://uploads.linear.app/x/y/z?sig=old-token' }
    ]
    const set = buildNormalizedUrlSet(attachments, 'linear_url')

    expect(set.size).toBe(2)
    expect(set.has('https://uploads.linear.app/a/b/c')).toBe(true)
    expect(set.has('https://uploads.linear.app/x/y/z')).toBe(true)
  })

  it('ignores attachments without the specified URL key', () => {
    const attachments = [
      { id: '1', notion_url: 'https://s3.example.com/file.png' },
      { id: '2' } // no notion_url
    ]
    const set = buildNormalizedUrlSet(attachments, 'notion_url')
    expect(set.size).toBe(1)
  })

  it('matches URLs with different query params to the same normalized key', () => {
    const existing = [
      { id: '1', linear_url: 'https://uploads.linear.app/org/team/file?sig=OLD&exp=111' }
    ]
    const set = buildNormalizedUrlSet(existing, 'linear_url')

    // A new sync returns the same file with a different signed URL
    const newUrl = 'https://uploads.linear.app/org/team/file?sig=NEW&exp=222'
    expect(set.has(normalizeUrlForComparison(newUrl))).toBe(true)
  })
})
