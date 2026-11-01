import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArtifactType } from '@shared/artifacts'
import { ArtifactCard } from './ArtifactCard'

afterEach(cleanup)

describe('ArtifactCard', () => {
  it('shows a workflow artifact with its name and opens it on tap', () => {
    const onOpen = vi.fn()
    render(<ArtifactCard artifact={{ id: 'task-1:workflow:wf-1', taskId: 'task-1', type: ArtifactType.WORKFLOW, title: 'Daily invoice PDF', url: 'https://app.workflo.example/flow?workflowId=wf-1&view=summary', updatedAt: 1, reloadTrigger: 0 }} onOpen={onOpen} />)
    expect(screen.getByText('Daily invoice PDF')).toBeTruthy()
    expect(screen.getByText('Workflow · Tap to open')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalled()
  })
})
