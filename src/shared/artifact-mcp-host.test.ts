import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleArtifactMcpMessage } from './artifact-mcp-host'

const html = '<script type="application/json" id="mcp-app-manifest">{"tools":["workflow_execute","wf_delete_all_abc123","workflow_list"]}</script>'
const confirm = vi.fn()

beforeEach(() => {
  confirm.mockReset()
  vi.stubGlobal('window', { confirm })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function request(name: string, id: number, path = 'a.html') {
  const reply = vi.fn()
  const call = vi.fn(async () => ({ content: [] }))
  return handleArtifactMcpMessage(html, { taskId: 't', path }, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }, reply, call)
    .then(() => ({ reply, call }))
}

describe('artifact MCP host', () => {
  it('a session write approval covers only the tool that was approved', async () => {
    // read consent, run, allow more of this tool
    confirm.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true)
    expect((await request('workflow_execute', 1, 'scoped.html')).call).toHaveBeenCalledTimes(1)
    const prompts = confirm.mock.calls.length
    expect((await request('workflow_execute', 2, 'scoped.html')).call).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls.length).toBe(prompts)

    confirm.mockReturnValueOnce(false)
    const other = await request('wf_delete_all_abc123', 3, 'scoped.html')
    expect(confirm.mock.calls.length).toBe(prompts + 1)
    expect(other.call).not.toHaveBeenCalled()
    expect(other.reply).toHaveBeenCalledWith(expect.objectContaining({ error: { code: -32002, message: 'Viewer denied this call' } }))
  })

  it('a failing hash still answers the frame instead of leaving the call pending', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'))
    const { reply, call } = await request('workflow_list', 7, 'hash.html')
    expect(call).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'Tool call failed' } })
  })
})
