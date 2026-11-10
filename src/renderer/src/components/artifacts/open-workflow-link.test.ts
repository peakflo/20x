import { beforeEach, describe, expect, it } from 'vitest'
import { ArtifactType } from '@shared/artifacts'
import { useArtifactStore } from '@/stores/artifact-store'
import { markdownLinkLabel, openWorkflowLink } from './open-workflow-link'

const panelUrl = 'https://app.workflo.example/flow?workflowId=wf-1&tenantId=t-1&view=summary'

beforeEach(() => {
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {}, turnsByTask: {}, hydratedTasks: {} })
})

describe('openWorkflowLink', () => {
  it('creates the workflow tab from the link label and opens it', () => {
    expect(openWorkflowLink('task-1', panelUrl, 'Daily invoice PDF')).toBe(true)
    const state = useArtifactStore.getState()
    expect(state.getArtifacts('task-1')).toEqual([expect.objectContaining({ id: 'task-1:workflow:wf-1', type: ArtifactType.WORKFLOW, title: 'Daily invoice PDF', url: panelUrl })])
    expect(state.getUI('task-1')).toEqual(expect.objectContaining({ open: true, activeTabId: 'task-1:workflow:wf-1' }))
  })

  it('reuses the tab made from tool output and keeps its title', () => {
    useArtifactStore.getState().upsertArtifact({ id: 'task-1:workflow:wf-1', taskId: 'task-1', type: ArtifactType.WORKFLOW, title: 'From tool', url: panelUrl, updatedAt: 1 })
    expect(openWorkflowLink('task-1', panelUrl, 'Other label')).toBe(true)
    const artifacts = useArtifactStore.getState().getArtifacts('task-1')
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].title).toBe('From tool')
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBe('task-1:workflow:wf-1')
  })

  it('leaves other links to the default behaviour', () => {
    expect(openWorkflowLink('task-1', 'https://example.com/flow?workflowId=wf-1', 'Editor')).toBe(false)
    expect(openWorkflowLink('task-1', 'https://github.com/peakflo/20x/pull/1')).toBe(false)
    expect(useArtifactStore.getState().getArtifacts('task-1')).toEqual([])
  })
})

describe('markdownLinkLabel', () => {
  it('finds the label of the link to the given URL', () => {
    const text = `Done. [Editor](https://x.example/flow?workflowId=wf-1) and [Daily invoice PDF](${panelUrl}).`
    expect(markdownLinkLabel(text, panelUrl)).toBe('Daily invoice PDF')
    expect(markdownLinkLabel(text, 'https://other.example')).toBeUndefined()
  })
})
