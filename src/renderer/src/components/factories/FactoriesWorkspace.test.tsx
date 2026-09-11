import { beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FactoriesWorkspace } from './FactoriesWorkspace'
import { syncFactoryCanvas } from './FactoryCanvas'
import { useUIStore } from '@/stores/ui-store'
import { useCanvasStore } from '@/stores/canvas-store'
import type { FactoryDefinition, ResponsibilitySnapshot, ResponsibilityStep } from '@shared/responsibilities'

vi.mock('@/stores/task-store', () => ({ useTaskStore: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ settingsApi: { get: vi.fn(), set: vi.fn() } }))
vi.mock('@/components/ui/MermaidDiagram', () => ({ MermaidDiagram: ({ code }: { code: string }) => <pre aria-label="Rendered diagram">{code}</pre> }))
const factory: FactoryDefinition = { id: 'factory', projectId: 'project', name: 'PR Review', diagram: 'graph TD\n A[Review] --> B[Decide]', guide: 'Inspect findings and ask the engineer before external communication.', provenance: 'Engineer confirmed', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
let snapshot: ResponsibilitySnapshot
let changed: () => void
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  useUIStore.setState({ mastermindDraft: null, showOrchestrator: false, canvasResponsibilityId: null })
  useCanvasStore.setState({ panels: [], edges: [], nextZIndex: 1 })
  snapshot = { projects: [{ id: 'project', name: 'Example', root: '/example', agentId: 'agent', createdAt: '2026-01-01' }, { id: 'other', name: 'Other', root: '/other', agentId: 'agent', createdAt: '2026-01-01' }], responsibilities: [], steps: [], memory: [], notices: [], factories: [factory], factoryProposals: [] }
  window.electronAPI.responsibilities = { setProactive: vi.fn(async () => {}), retryFollowups: vi.fn(async () => {}), snapshot: vi.fn(async () => structuredClone(snapshot)), onChanged: vi.fn(callback => { changed = callback; return vi.fn() }), decideFactory: vi.fn(async (id) => { snapshot.factoryProposals = snapshot.factoryProposals?.filter(p => p.id !== id); changed() }), act: vi.fn(), answer: vi.fn(), remember: vi.fn(), forget: vi.fn(), createProject: vi.fn(), pickProjectFolder: vi.fn() }
})

it('shows diagrams/instructions, filters by project, and drafts Use/Edit/Create in the correct Mastermind without sending', async () => {
  render(<FactoriesWorkspace />)
  expect(await screen.findByLabelText('Rendered diagram')).toHaveTextContent('A[Review]')
  expect(screen.getByText(factory.guide)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(useUIStore.getState()).toMatchObject({ showOrchestrator: true, mastermindDraft: { projectId: 'project', text: expect.stringContaining('(ID factory)') } })
  fireEvent.click(screen.getByRole('button', { name: 'Edit in Mastermind' }))
  expect(useUIStore.getState().mastermindDraft?.text).toContain('revise Factory')
  fireEvent.change(screen.getByLabelText('Factory project'), { target: { value: 'other' } })
  expect(screen.queryByRole('button', { name: 'Use' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Create in Mastermind' }))
  expect(useUIStore.getState().mastermindDraft?.projectId).toBe('other')
  expect(window.electronAPI.responsibilities.decideFactory).not.toHaveBeenCalled()
})

it('shows the exact pending definition, saves only on confirmation, and refreshes deletion', async () => {
  snapshot.factoryProposals = [{ id: 'preview', operation: 'save', replacesDigest: 'old', definition: { ...factory, guide: 'New exact guide' } }]
  render(<FactoriesWorkspace />)
  expect(await screen.findByText('New exact guide')).toBeInTheDocument()
  expect(window.electronAPI.responsibilities.decideFactory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save this Factory' }))
  await waitFor(() => expect(window.electronAPI.responsibilities.decideFactory).toHaveBeenCalledWith('preview', true))
  await act(async () => { snapshot.factories = []; changed() })
  expect(await screen.findByText(/No saved Factories yet/)).toBeInTheDocument()
})

it('adds only actual tasks to the canvas, connects their handoffs, and preserves panels across repeated updates', () => {
  const steps = [{ id: 's1', taskId: 'review', predecessorTaskIds: [] }, { id: 's2', taskId: 'fix', predecessorTaskIds: ['review'] }] as unknown as ResponsibilityStep[]
  const tasks = [{ id: 'review', title: 'Review' }, { id: 'fix', title: 'Fix' }]
  syncFactoryCanvas(steps.slice(0, 1), tasks)
  const panel = useCanvasStore.getState().panels[0]
  useCanvasStore.getState().updatePanel(panel.id, { x: 777, y: 222 })
  syncFactoryCanvas(steps, tasks)
  syncFactoryCanvas(steps, tasks)
  expect(useCanvasStore.getState().panels).toHaveLength(2)
  expect(useCanvasStore.getState().edges).toHaveLength(1)
  expect(useCanvasStore.getState().panels[0]).toMatchObject({ x: 777, y: 222 })
})
