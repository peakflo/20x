import { Worker } from 'worker_threads'
import { join } from 'path'
import type { WorkspaceCleanupJob, WorkspaceCleanupJobResult, WorkspaceCleanupWorkerProgress } from './workspace-cleanup-operations'

export function workspaceCleanupWorkerPath(directory = __dirname): string {
  return join(directory, 'workspace-cleanup-worker.js').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

export function runWorkspaceCleanupWorker(
  job: WorkspaceCleanupJob,
  onProgress?: (progress: WorkspaceCleanupWorkerProgress) => void
): Promise<WorkspaceCleanupJobResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workspaceCleanupWorkerPath(), { workerData: job })
    let settled = false
    worker.on('message', (message: { type: string; progress?: WorkspaceCleanupWorkerProgress; result?: WorkspaceCleanupJobResult; message?: string }) => {
      if (message.type === 'progress' && message.progress) onProgress?.(message.progress)
      if (message.type === 'result' && message.result) {
        settled = true
        resolve(message.result)
      }
      if (message.type === 'error') {
        settled = true
        reject(new Error(message.message ?? 'Workspace cleanup worker failed'))
      }
    })
    worker.on('error', (error) => {
      if (!settled) { settled = true; reject(error) }
    })
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`Workspace cleanup worker exited with code ${code}`))
    })
  })
}
