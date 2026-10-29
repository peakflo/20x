import { parentPort, workerData } from 'worker_threads'
import { executeWorkspaceCleanupJob, type WorkspaceCleanupJob } from './workspace-cleanup-operations'

void executeWorkspaceCleanupJob(workerData as WorkspaceCleanupJob, (progress) => {
  parentPort?.postMessage({ type: 'progress', progress })
}).then(
  (result) => parentPort?.postMessage({ type: 'result', result }),
  (error) => parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
)
