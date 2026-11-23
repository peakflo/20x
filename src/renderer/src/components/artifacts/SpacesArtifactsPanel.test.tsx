import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import type { SpacesArtifactSummary } from '@shared/enterprise-runners'
import { useSpacesArtifactStore } from '@/stores/spaces-artifact-store'
import { SpacesArtifactsPanel } from './SpacesArtifactsPanel'

const list = vi.fn()
const read = vi.fn()

const spaces = (over: Partial<SpacesArtifactSummary> = {}): SpacesArtifactSummary => ({
  id: 'spaces:s1:a1', artifactId: 'a1', sessionId: 's1', title: 'root-cause.md', kind: 'markdown', filename: 'root-cause.md',
  sizeBytes: 2048, updatedAt: null, webUrl: 'https://app.peakflo.ai/a/a1', availability: 'live', readOnly: true, ...over
})
const local: Artifact = { id: 'l1', taskId: 't1', type: ArtifactType.MARKDOWN, title: 'notes.md', path: 'notes.md', updatedAt: 1, reloadTrigger: 0 }

beforeEach(() => {
  useSpacesArtifactStore.setState({ byTask: {} })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { enterpriseRunners: { listSpacesArtifacts: list, readSpacesArtifact: read }, shell: { openExternal: vi.fn() } }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('SpacesArtifactsPanel', () => {
  it('shows source badges for Local and Spaces rows and filters', async () => {
    list.mockResolvedValue({ status: 'ok', artifacts: [spaces()], syncedAt: 1 })
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[local]} onOpenLocal={vi.fn()} />)
    expect(await screen.findByText('root-cause.md')).toBeTruthy()
    expect(screen.getByTestId('source-badge-spaces')).toBeTruthy()
    expect(screen.getByTestId('source-badge-local')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'local' }))
    expect(screen.queryByText('root-cause.md')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'spaces' }))
    expect(screen.queryByText('notes.md')).toBeNull()
  })

  it('opens local artifacts via the normal tab path', async () => {
    list.mockResolvedValue({ status: 'ok', artifacts: [], syncedAt: 1 })
    const onOpenLocal = vi.fn()
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[local]} onOpenLocal={onOpenLocal} />)
    fireEvent.click(await screen.findByText('notes.md'))
    expect(onOpenLocal).toHaveBeenCalledWith('l1')
  })

  it('Spaces artifacts are read-only: no edit control, Open in Spaces available', async () => {
    list.mockResolvedValue({ status: 'ok', artifacts: [spaces()], syncedAt: 1 })
    read.mockResolvedValue({ availability: 'live', encoding: 'utf8', mimeType: 'text/markdown', content: '## Root cause\nretry timer', sizeBytes: 20, webUrl: 'https://app.peakflo.ai/a/a1' })
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[]} onOpenLocal={vi.fn()} />)
    fireEvent.click(await screen.findByText('root-cause.md'))
    expect(await screen.findByText('Root cause')).toBeTruthy()
    expect(screen.getByText('read-only')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /edit|save/i })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open in Spaces/ }))
    expect((window.electronAPI as unknown as { shell: { openExternal: ReturnType<typeof vi.fn> } }).shell.openExternal).toHaveBeenCalledWith('https://app.peakflo.ai/a/a1')
    expect(screen.getByText(/Editing server artifacts isn’t part of v1/)).toBeTruthy()
  })

  it('loading state', async () => {
    list.mockReturnValue(new Promise(() => {}))
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[]} onOpenLocal={vi.fn()} />)
    expect(await screen.findByTestId('spaces-artifacts-loading')).toBeTruthy()
    expect(screen.getByText('Fetching artifacts from Spaces…')).toBeTruthy()
  })

  it('offline state shows cached rows and a banner; uncached rows are flagged', async () => {
    list.mockResolvedValue({ status: 'offline', syncedAt: Date.now(), artifacts: [spaces({ availability: 'cached' }), spaces({ id: 'spaces:s1:a2', title: 'ci-logs.zip', kind: 'file', availability: 'not-cached' })] })
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[local]} onOpenLocal={vi.fn()} />)
    expect(await screen.findByTestId('spaces-artifacts-offline')).toBeTruthy()
    expect(screen.getByText('cached')).toBeTruthy()
    expect(screen.getByText('not cached')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
  })

  it('empty state', async () => {
    list.mockResolvedValue({ status: 'empty', artifacts: [], syncedAt: 1 })
    render(<SpacesArtifactsPanel taskId="t1" localArtifacts={[]} onOpenLocal={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('spaces-artifacts-empty')).toBeTruthy())
    expect(screen.getByText(/appear here with a “Spaces” label/)).toBeTruthy()
  })
})
