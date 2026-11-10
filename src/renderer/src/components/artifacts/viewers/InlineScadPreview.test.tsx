import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { InlineScadPreview } from './InlineScadPreview'

vi.mock('./ScadModelView', () => ({ ScadModelView: () => <div>3D model shown</div> }))

afterEach(cleanup)

// The 3D view is code-split with React.lazy, and React 19 holds a Suspense
// reveal for at least 300ms. Under a busy test runner, resolving the lazy
// module can take seconds, so the default 1s waitFor is not enough.
const MODEL_REVEAL_TIMEOUT_MS = 10_000

describe('inline SCAD preview', () => {
  it('renders only after Show 3D and keeps the editor action', { timeout: 20_000 }, async () => {
    // Warm the mocked lazy module so the Suspense reveal does not wait on module loading.
    await import('./ScadModelView')
    const artifact: Artifact = { id: 'case', taskId: 'task', type: ArtifactType.FILE, title: 'case.scad', path: 'case.scad', updatedAt: 10, reloadTrigger: 0 }
    const renderModel = vi.fn().mockResolvedValue('stl bytes')
    const onOpen = vi.fn()
    const view = render(<InlineScadPreview artifact={artifact} renderModel={renderModel} onOpen={onOpen} />)
    expect(renderModel).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Show 3D' }))
    await waitFor(() => expect(view.getByText('3D model shown')).toBeTruthy(), { timeout: MODEL_REVEAL_TIMEOUT_MS })
    expect(renderModel).toHaveBeenCalledWith('task', 'case.scad')
    fireEvent.click(view.getByRole('button', { name: 'Open editor' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
