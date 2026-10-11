import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { InlineScadPreview } from './InlineScadPreview'

vi.mock('./ScadModelView', () => ({ ScadModelView: () => <div>3D model shown</div> }))

afterEach(cleanup)

describe('inline SCAD preview', () => {
  it('renders only after Show 3D and keeps the editor action', async () => {
    const artifact: Artifact = { id: 'case', taskId: 'task', type: ArtifactType.FILE, title: 'case.scad', path: 'case.scad', updatedAt: 10, reloadTrigger: 0 }
    const renderModel = vi.fn().mockResolvedValue('stl bytes')
    const onOpen = vi.fn()
    const view = render(<InlineScadPreview artifact={artifact} renderModel={renderModel} onOpen={onOpen} />)
    expect(renderModel).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Show 3D' }))
    await waitFor(() => expect(view.getByText('3D model shown')).toBeTruthy())
    expect(renderModel).toHaveBeenCalledWith('task', 'case.scad')
    fireEvent.click(view.getByRole('button', { name: 'Open editor' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
