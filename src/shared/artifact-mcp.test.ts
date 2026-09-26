import { describe, expect, it } from 'vitest'
import { artifactManifestAllows, artifactToolsFromHtml, isArtifactCallableTool, isArtifactWriteTool } from './artifact-mcp'

describe('artifact workspace tool policy', () => {
  it('reads the portable manifest and accepts only a trailing workflow glob', () => {
    const tools = artifactToolsFromHtml('<script type="application/json" id="mcp-app-manifest">{"tools":["workflow_list","wf_cash_flow_*"]}</script>')
    expect(tools).toEqual(['workflow_list', 'wf_cash_flow_*'])
    expect(artifactManifestAllows(tools, 'wf_cash_flow_123')).toBe(true)
    expect(artifactManifestAllows(tools, 'workflow_execute')).toBe(false)
    expect(artifactToolsFromHtml('<script type="application/json" id="mcp-app-manifest">{"tools":["*_delete"]}</script>')).toEqual([])
  })

  it('keeps authoring and integration calls outside the bridge', () => {
    expect(isArtifactCallableTool('workflow_list')).toBe(true)
    expect(isArtifactWriteTool('workflow_execute')).toBe(true)
    expect(isArtifactWriteTool('wf_cash_flow_123')).toBe(true)
    for (const name of ['workflow_add_node', 'workflow_create', 'integration_mcp_tool_call', 'table_sql_execute']) {
      expect(isArtifactCallableTool(name)).toBe(false)
    }
  })
})
