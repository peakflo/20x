import { describe, expect, it } from 'vitest'
import { workspaceCleanupWorkerPath } from './workspace-cleanup-worker-client'

describe('workspace cleanup worker path', () => {
  it('uses the unpacked worker in a packaged app', () => {
    expect(workspaceCleanupWorkerPath('/Applications/20x.app/Contents/Resources/app.asar/out/main'))
      .toBe('/Applications/20x.app/Contents/Resources/app.asar.unpacked/out/main/workspace-cleanup-worker.js')
  })
})
