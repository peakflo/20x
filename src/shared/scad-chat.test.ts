import { describe, expect, it } from 'vitest'
import { ArtifactType, type Artifact } from './artifacts'
import { findChatScadArtifact } from './scad-chat'

const model: Artifact = { id: 'model', taskId: 'task', type: ArtifactType.FILE, title: 'Case model', path: 'attachments/zero2w_case.scad', updatedAt: 1, reloadTrigger: 0 }

describe('SCAD files in chat', () => {
  it('finds an attached file named in a message', () => {
    expect(findChatScadArtifact({ content: 'Please show zero2w_case.scad' }, [model])).toBe(model)
  })

  it('finds a file in a finished tool call but skips work in progress', () => {
    const tool = { status: 'success', input: 'attachments/zero2w_case.scad' }
    expect(findChatScadArtifact({ content: '', tool }, [model])).toBe(model)
    expect(findChatScadArtifact({ content: '', tool: { ...tool, status: 'running' } }, [model])).toBeUndefined()
  })

  it('does not treat other files as 3D models', () => {
    const other = { ...model, path: 'notes.txt' }
    expect(findChatScadArtifact({ content: 'notes.txt' }, [other])).toBeUndefined()
  })
})
