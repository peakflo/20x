import { describe, expect, it } from 'vitest'
import { ArtifactType, artifactWorkpieceForPath, isArtifactDeliverablePath, extractWorkflowPanelLinks, workflowArtifactId, workflowPanelFromTool, workflowPanelRefFromUrl, workflowPanelUrlFromTool } from './artifacts'

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
    expect(artifactWorkpieceForPath('repo/output/final.pdf', ArtifactType.FILE)).not.toBeNull()
    expect(artifactWorkpieceForPath('outputs/dashboard/styles.css', ArtifactType.FILE)).toEqual({
      key: 'outputs/dashboard',
      title: 'dashboard',
      grouped: true
    })
  })
})

describe('Spaces workflow summary links', () => {
  const panelUrl = 'https://app.workflo.example/flow?workflowId=wf-1&tenantId=t-1&view=summary'

  it('accepts /flow links with workflowId and view=summary from any http(s) origin', () => {
    expect(workflowPanelRefFromUrl(panelUrl)).toEqual({ url: panelUrl, workflowId: 'wf-1', tenantId: 't-1' })
    expect(workflowPanelRefFromUrl('http://localhost:3000/flow/?view=summary&workflowId=wf-2')).toEqual(expect.objectContaining({ workflowId: 'wf-2' }))
  })

  it('ignores other links', () => {
    expect(workflowPanelRefFromUrl('https://app.workflo.example/flow?workflowId=wf-1')).toBeUndefined()
    expect(workflowPanelRefFromUrl('https://app.workflo.example/flow?workflowId=wf-1&view=graph')).toBeUndefined()
    expect(workflowPanelRefFromUrl('https://app.workflo.example/flows?workflowId=wf-1&view=summary')).toBeUndefined()
    expect(workflowPanelRefFromUrl('https://app.workflo.example/flow?view=summary')).toBeUndefined()
    expect(workflowPanelRefFromUrl('/flow?workflowId=wf-1&view=summary')).toBeUndefined()
    expect(workflowPanelRefFromUrl('javascript:alert(1)//flow?workflowId=1&view=summary')).toBeUndefined()
  })

  it('reads panelUrl from prefixed Spaces workflow tools only', () => {
    const output = JSON.stringify({ workflowId: 'wf-1', name: 'Daily invoice PDF', panelUrl })
    for (const name of ['workflow_test_run', 'mcp__workflo__workflow_save_version', 'mcp__workflo-stage__workflow_editor_link', 'workflo.workflow_evidence_report']) {
      expect(workflowPanelFromTool({ name, status: 'completed', output })).toEqual({ url: panelUrl, workflowId: 'wf-1', title: 'Daily invoice PDF' })
    }
    expect(workflowPanelUrlFromTool({ name: 'mcp__workflo__workflow_test_run', status: 'completed', output })).toBe(panelUrl)
    expect(workflowPanelFromTool({ name: 'mcp__workflo__workflow_get', status: 'completed', output })).toBeUndefined()
    expect(workflowPanelFromTool({ name: 'Read', status: 'completed', output })).toBeUndefined()
    expect(workflowPanelFromTool({ name: 'workflow_test_run', status: 'error', output })).toBeUndefined()
  })

  it('reads panelUrl from MCP content blocks and plain text', () => {
    const blocks = [{ type: 'text', text: JSON.stringify({ result: { panelUrl, workflow: { name: 'Nested name' } } }) }]
    expect(workflowPanelFromTool({ name: 'workflow_test_run', status: 'success', output: blocks })).toEqual({ url: panelUrl, workflowId: 'wf-1', title: 'Nested name' })
    expect(workflowPanelFromTool({ name: 'workflow_test_run', status: 'success', output: `Run passed.\npanelUrl: ${panelUrl}\n` })).toEqual({ url: panelUrl, workflowId: 'wf-1', title: 'Workflow' })
    expect(workflowPanelFromTool({ name: 'workflow_test_run', status: 'success', output: { panelUrl: 'https://app.workflo.example/flow?workflowId=wf-1' } })).toBeUndefined()
  })

  it('gives one artifact id for each workflow in a task', () => {
    expect(workflowArtifactId('task-1', 'wf 1')).toBe('task-1:workflow:wf%201')
  })
})

describe('extractWorkflowPanelLinks', () => {
  const url = 'https://app.workflo.example/flow?workflowId=wf-1&tenantId=t-1&view=summary'

  it('removes a link alone on its line, also as a list item or a bare URL', () => {
    expect(extractWorkflowPanelLinks(`Done.\n\n[Daily bills](${url})`)).toEqual({ text: 'Done.', links: [{ workflowId: 'wf-1', name: 'Daily bills', url }] })
    expect(extractWorkflowPanelLinks(`Done.\n- [Daily bills](${url}).`).text).toBe('Done.')
    expect(extractWorkflowPanelLinks(`Done.\n${url}`)).toEqual({ text: 'Done.', links: [{ workflowId: 'wf-1', name: 'Workflow', url }] })
  })

  it('keeps the words of a link inside a sentence and adds one card for each workflow', () => {
    const result = extractWorkflowPanelLinks(`I built [Daily bills](${url}). Open [it](${url}) now.`)
    expect(result.text).toBe('I built Daily bills. Open it now.')
    expect(result.links).toEqual([{ workflowId: 'wf-1', name: 'Daily bills', url }])
  })

  it('does not change code fences or other links', () => {
    const fenced = '```\n[x](' + url + ')\n```'
    expect(extractWorkflowPanelLinks(fenced)).toEqual({ text: fenced, links: [] })
    const other = '[Editor](https://app.workflo.example/flow?workflowId=wf-1&view=graph)'
    expect(extractWorkflowPanelLinks(other)).toEqual({ text: other, links: [] })
  })
})

