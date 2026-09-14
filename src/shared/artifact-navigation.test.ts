import { describe, expect, it } from 'vitest'
import { isLocalArtifactLink, resolveArtifactLink } from './artifact-navigation'

const files = ['artifacts/demo/docs/start.md', 'artifacts/demo/data/my file.csv', 'artifacts/demo/index.html']
describe('artifact file links', () => {
  it.each([
    ['../data/my%20file.csv?download=1#row', files[1]],
    ['../index.html', files[2]],
    ['/artifacts/demo/index.html', files[2]],
    ['artifacts/demo/index.html', files[2]]
  ])('resolves %s against the selected file and inventory', (href, expected) => {
    expect(resolveArtifactLink(files[0], href, files)).toBe(expected)
  })
  it.each(['../../../secret.txt', '../missing.md', '%zz', '%00', '..%5csecret.txt', 'https://example.com', '//example.com', 'file:///secret.txt', '#heading'])('does not read %s', (href) => {
    expect(resolveArtifactLink(files[0], href, files)).toBeNull()
  })
  it.each(['https://example.com', 'mailto:a@example.com', '#heading', '//example.com'])('leaves %s to the existing link handler', (href) => {
    expect(isLocalArtifactLink(href)).toBe(false)
  })
})
