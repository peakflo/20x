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

  it('switches between 3D, source, and both without losing the source draft', async () => {
    const renderModel = vi.fn().mockResolvedValue('c3Rs')
    render(<ScadEditor artifact={artifact} content={{ kind: ArtifactContentKind.TEXT, content: 'cube(10);' }} renderModel={renderModel} />)
    await screen.findByText('3D model')
    expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: 'SCAD 3D model' }).nextElementSibling).toBe(screen.getByRole('separator', { name: 'Resize source panel' }))
    expect(screen.getByRole('separator', { name: 'Resize source panel' }).nextElementSibling).toBe(screen.getByRole('region', { name: 'SCAD source panel' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'SCAD source' }), { target: { value: 'cube(12);' } })

    fireEvent.click(screen.getByRole('button', { name: '3D artifact' }))
    expect(screen.queryByRole('textbox', { name: 'SCAD source' })).toBeNull()
    expect(screen.getByRole('region', { name: 'SCAD 3D model' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.queryByRole('region', { name: 'SCAD 3D model' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'SCAD source' }) as HTMLTextAreaElement).value).toBe('cube(12);')
  })

  it('changes the bottom source height with the divider', () => {
    render(<ScadEditor artifact={artifact} content={{ kind: ArtifactContentKind.TEXT, content: 'cube(10);' }} />)
    const divider = screen.getByRole('separator', { name: 'Resize source panel' })
    const sourcePanel = screen.getByRole('region', { name: 'SCAD source panel' })
    Object.defineProperty(divider.parentElement, 'clientHeight', { configurable: true, value: 600 })
    expect(sourcePanel.style.height).toBe('240px')
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientY: 400 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 320 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(sourcePanel.style.height).toBe('320px')
    fireEvent.keyDown(divider, { key: 'ArrowDown' })
    expect(sourcePanel.style.height).toBe('300px')
  })
})
