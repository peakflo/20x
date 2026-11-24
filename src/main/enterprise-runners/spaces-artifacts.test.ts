import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactContentKind } from '../../shared/artifacts'
import {
  assertNotSpacesArtifact,
  isSpacesArtifactPath,
  readSpacesArtifact,
  setSpacesArtifactReader,
  SpacesArtifactReadOnlyError,
  toArtifactContent
} from './spaces-artifacts'

afterEach(() => setSpacesArtifactReader(null))

const content = (over: Record<string, unknown> = {}) => ({ availability: 'live', encoding: 'utf8', mimeType: 'text/markdown', content: 'hi', sizeBytes: 2, webUrl: null, ...over }) as never

describe('Spaces artifacts in the existing artifact IPC', () => {
  it('recognises only spaces: paths', () => {
    expect(isSpacesArtifactPath('spaces:s1:a1')).toBe(true)
    expect(isSpacesArtifactPath('artifacts/demo/index.html')).toBe(false)
    expect(isSpacesArtifactPath(undefined)).toBe(false)
  })

  it('refuses writes to a Spaces artifact and ignores local paths', () => {
    expect(() => assertNotSpacesArtifact('spaces:s1:a1')).toThrow(SpacesArtifactReadOnlyError)
    expect(() => assertNotSpacesArtifact('notes.md')).not.toThrow()
  })

  it('hands text to the existing viewers as TEXT and images as a data URL', () => {
    expect(toArtifactContent(content())).toEqual({ kind: ArtifactContentKind.TEXT, content: 'hi', mimeType: 'text/markdown' })
    expect(toArtifactContent(content({ encoding: 'base64', mimeType: 'image/png', content: 'AAAA' }))).toEqual({
      kind: ArtifactContentKind.DATA_URL, content: 'data:image/png;base64,AAAA', mimeType: 'image/png'
    })
  })

  it('explains an uncached artifact when offline instead of showing nothing', () => {
    expect(() => toArtifactContent(content({ availability: 'not-cached', encoding: 'none', content: null }))).toThrow(/not available offline/)
  })

  it('needs a signed-in runtime to read', async () => {
    await expect(readSpacesArtifact('t', 'spaces:s:a')).rejects.toThrow(/Sign in/)
    setSpacesArtifactReader(async () => content())
    await expect(readSpacesArtifact('t', 'spaces:s:a')).resolves.toMatchObject({ content: 'hi' })
  })
})
