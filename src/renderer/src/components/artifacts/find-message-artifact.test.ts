import { describe, expect, it } from 'vitest'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { findMessageArtifact } from './find-message-artifact'

const artifact = {
  id: 'task:workpiece:artifact_chart_abc12345', taskId: 'task',
  type: ArtifactType.HTML, title: 'Chart',
  path: 'artifacts/artifact_chart_abc12345/index.html',
  updatedAt: 1, reloadTrigger: 0
} as Artifact

describe('findMessageArtifact', () => {
  it.each([
    JSON.stringify({ artifact_id: 'artifact_chart_abc12345' }),
    JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ artifact_id: 'artifact_chart_abc12345' }) }] } })
  ])('matches a completed HTML tool result by artifact ID', (output) => {
    expect(findMessageArtifact({ tool: { status: 'success', output } }, [artifact])).toBe(artifact)
  })
})
