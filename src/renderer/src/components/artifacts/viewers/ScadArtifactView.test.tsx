import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactContentKind, ArtifactType, type Artifact } from '@shared/artifacts'
import { ScadEditor } from './ScadArtifactView'

vi.mock('./ScadModelView', () => ({ ScadModelView: () => <div>3D model</div> }))

const artifact: Artifact = {
  id: 'case', taskId: 'task-1', title: 'case.scad', type: ArtifactType.FILE,
  path: 'attachments/case.scad', updatedAt: 1, reloadTrigger: 0
}

afterEach(cleanup)

describe('SCAD editor', () => {
  it('edits, saves, and renders the selected file', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const renderModel = vi.fn().mockResolvedValue('c3Rs')
    render(<ScadEditor artifact={artifact} content={{ kind: ArtifactContentKind.TEXT, content: 'cube(10);' }} save={save} renderModel={renderModel} />)
    await waitFor(() => expect(renderModel).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('textbox', { name: 'SCAD source' }), { target: { value: 'cube(12);' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('task-1', 'attachments/case.scad', 'cube(12);', 'cube(10);'))
    expect((screen.getByRole('textbox', { name: 'SCAD source' }) as HTMLTextAreaElement).value).toBe('cube(12);')
  })

  it('keeps an edit when a fresh file arrives and offers reload', async () => {
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: 'cube(14);' })
    const renderModel = vi.fn().mockRejectedValue(new Error('Install OpenSCAD to show a 3D preview.'))
    const { rerender } = render(<ScadEditor artifact={artifact} content={{ kind: ArtifactContentKind.TEXT, content: 'cube(10);' }} read={read} renderModel={renderModel} />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'SCAD source' }), { target: { value: 'cube(12);' } })
    rerender(<ScadEditor artifact={artifact} content={{ kind: ArtifactContentKind.TEXT, content: 'cube(11);' }} read={read} renderModel={renderModel} />)
    expect((screen.getByRole('textbox', { name: 'SCAD source' }) as HTMLTextAreaElement).value).toBe('cube(12);')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'SCAD source' }) as HTMLTextAreaElement).value).toBe('cube(14);'))
  })
})
