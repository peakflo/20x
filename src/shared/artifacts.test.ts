import { describe, expect, it } from 'vitest'
import { ArtifactType, artifactWorkpieceForPath, isArtifactDeliverablePath } from './artifacts'

describe('artifact deliverable boundary', () => {
  it('keeps repository source and documentation out of artifact tabs', () => {
    expect(isArtifactDeliverablePath('20x/src/App.tsx', ArtifactType.FILE)).toBe(false)
    expect(isArtifactDeliverablePath('20x/docs/architecture.md', ArtifactType.MARKDOWN)).toBe(false)
    expect(isArtifactDeliverablePath('20x/public/index.html', ArtifactType.HTML)).toBe(false)
  })

  it('accepts standalone previews and explicit deliverable directories', () => {
    expect(isArtifactDeliverablePath('summary.md', ArtifactType.MARKDOWN)).toBe(true)
    expect(isArtifactDeliverablePath('outputs/demo/index.html', ArtifactType.HTML)).toBe(true)
    expect(isArtifactDeliverablePath('repo/reports/data.json', ArtifactType.FILE)).toBe(true)
    expect(isArtifactDeliverablePath('.20x/artifacts/chart.png', ArtifactType.IMAGE)).toBe(true)
  })

  it('does not promote a generic root source file', () => {
    expect(isArtifactDeliverablePath('package.json', ArtifactType.FILE)).toBe(false)
  })

  it('groups supporting files beneath one named output workpiece', () => {
    expect(artifactWorkpieceForPath('outputs/dashboard/index.html', ArtifactType.HTML)).toEqual({
      key: 'outputs/dashboard',
      title: 'dashboard',
      grouped: true
    })
    expect(artifactWorkpieceForPath('outputs/dashboard/styles.css', ArtifactType.FILE)).toEqual({
      key: 'outputs/dashboard',
      title: 'dashboard',
      grouped: true
    })
  })
})
