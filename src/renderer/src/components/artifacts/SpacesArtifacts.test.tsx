import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { ArtifactClipboardMode, ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi } from '@shared/artifacts'
import { spacesSummaryToArtifact } from '@shared/enterprise-runners'
import { PinnedArtifactTabId, useArtifactStore } from '@/stores/artifact-store'

const listSpacesArtifacts = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc-client', () => ({
  enterpriseRunnersApi: { listSpacesArtifacts },
  onArtifactUpdated: vi.fn()
}))
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg />' }) } }))

import { ArtifactsPanel } from './ArtifactsPanel'
import { ArtifactTabStrip } from './ArtifactTabStrip'
import { ArtifactRail } from './ArtifactRail'
import { useSpacesArtifacts } from '@/hooks/use-spaces-artifacts'

const summary = (id: string, title: string, kind: 'markdown' | 'html' | 'image' | 'file' = 'markdown') => ({
  id: `spaces:s1:${id}`, artifactId: id, sessionId: 's1', title, kind, filename: title, sizeBytes: 5, updatedAt: '2026-11-23T10:00:00Z',
  webUrl: 'https://app.peakflo.ai/coding-agents/s1', availability: 'live' as const, readOnly: true as const
})
const spaces = (id: string, title: string, kind: 'markdown' | 'html' | 'image' | 'file' = 'markdown'): Artifact => ({
  ...spacesSummaryToArtifact('task-1', summary(id, title, kind)), id: `art-${id}`, reloadTrigger: 0
})
const local: Artifact = { id: 'local-1', taskId: 'task-1', title: 'notes.md', type: ArtifactType.MARKDOWN, path: 'notes.md', updatedAt: 1, reloadTrigger: 0 }

const openExternal = vi.fn()
beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { shell: { openExternal } }
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {}, hydratedTasks: {} })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function panel(active: string, artifacts: Artifact[], api: Partial<ArtifactApi>) {
  return render(
    <ArtifactsPanel
      taskId="task-1" artifacts={artifacts} ui={{ open: true, activeTabId: active, railExpanded: false }}
      artifactApi={{ scan: vi.fn(), read: vi.fn().mockResolvedValue(null), copyFile: vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.FILE }), ...api }}
      hasChanges={false} hasOutput={false} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onToggleOpen={vi.fn()} onToggleRail={vi.fn()}
      details={null} changes={null} output={null}
    />
  )
}

describe('Spaces artifacts use the existing artifact tabs and viewers', () => {
  it('shows them as normal tabs with a Spaces badge next to local ones, and there is no separate pinned tab', () => {
    render(<ArtifactTabStrip artifacts={[local, spaces('a1', 'root-cause.md')]} activeTabId="local-1" hasChanges={false} hasOutput={false} onSelectTab={vi.fn()} onCloseTab={vi.fn()} />)
    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(screen.getByText('root-cause.md')).toBeTruthy()
    expect(screen.getAllByTestId('spaces-badge')).toHaveLength(1) // only the Spaces one
    expect(Object.values(PinnedArtifactTabId)).not.toContain('spaces-artifacts')
  })

  it('marks Spaces artifacts in the rail too', () => {
    render(<ArtifactRail artifacts={[local, spaces('a1', 'root-cause.md')]} expanded activeTabId="local-1" onSelectTab={vi.fn()} onToggleExpanded={vi.fn()} />)
    expect(screen.getAllByTestId('spaces-badge')).toHaveLength(1)
  })

  it('opens a Spaces markdown artifact in the standard viewer with the Spaces header and Open in Spaces', async () => {
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '## Root cause\n\nThe retry timer fires early.' })
    panel('art-a1', [spaces('a1', 'root-cause.md')], { read })
    expect(await screen.findByText('Root cause')).toBeTruthy()
    expect(read).toHaveBeenCalledWith('task-1', 'spaces:s1:a1') // same read call local files use
    expect(screen.getByTestId('spaces-artifact-header').textContent).toContain('Read-only')
    fireEvent.click(screen.getByRole('button', { name: /Open in Spaces/ }))
    expect(openExternal).toHaveBeenCalledWith('https://app.peakflo.ai/coding-agents/s1')
  })

  it('hides edit and file actions for Spaces artifacts and keeps them for local ones', async () => {
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: 'hello' })
    const view = panel('art-a1', [spaces('a1', 'root-cause.md')], { read })
    await screen.findByText('hello')
    expect(screen.queryByRole('button', { name: 'Copy file' })).toBeNull() // no workspace file to copy
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy() // copying the text still works
    expect(screen.queryByRole('button', { name: /edit|save/i })).toBeNull()
    view.unmount()
    panel('local-1', [local], { read })
    await screen.findByText('hello')
    expect(screen.queryByTestId('spaces-artifact-header')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy file' })).toBeTruthy()
  })

  it('renders a Spaces image through the standard image viewer', async () => {
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.DATA_URL, content: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    panel('art-i1', [spaces('i1', 'chart.png', 'image')], { read })
    const img = await screen.findByAltText('chart.png')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('shows the existing error state when an artifact is not available offline', async () => {
    const read = vi.fn().mockRejectedValue(new Error('This Spaces artifact is not available offline.'))
    panel('art-a1', [spaces('a1', 'root-cause.md')], { read })
    expect(await screen.findByText(/not available offline/)).toBeTruthy()
  })

  it('never wires the tool bridge for Spaces HTML', async () => {
    const mcpCall = vi.fn()
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '<p>chart</p>' })
    panel('art-h1', [spaces('h1', 'flake.html', 'html')], { read, mcpCall })
    await waitFor(() => expect(screen.getByTitle('flake.html')).toBeTruthy())
    expect(mcpCall).not.toHaveBeenCalled()
  })
})

describe('useSpacesArtifacts', () => {
  it('upserts Spaces artifacts into the existing artifact store, without a second list', async () => {
    listSpacesArtifacts.mockResolvedValue({ status: 'ok', syncedAt: 1, artifacts: [summary('a1', 'root-cause.md'), summary('a2', 'flake.html', 'html')] })
    renderHook(() => useSpacesArtifacts('task-1', true))
    await waitFor(() => expect(useArtifactStore.getState().getArtifacts('task-1')).toHaveLength(2))
    const [first] = useArtifactStore.getState().getArtifacts('task-1')
    expect(first).toMatchObject({ source: 'spaces', readOnly: true, remoteId: 'a1', path: 'spaces:s1:a1' })
    // The store does not steal focus from what the user is looking at.
    expect(useArtifactStore.getState().getUI('task-1').open).toBe(false)
  })

  it('does nothing for a task that is not on a runner', () => {
    renderHook(() => useSpacesArtifacts('task-1', false))
    expect(listSpacesArtifacts).not.toHaveBeenCalled()
  })
})
