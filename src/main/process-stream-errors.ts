import { isBenignStreamError } from './child-stream-guards'

export function handleProcessStreamError(
  streamName: 'stdout' | 'stderr',
  err: NodeJS.ErrnoException
): void {
  // One shared list of benign codes, so this handler and the child-process
  // pipe guards can never disagree about what counts as a crash.
  if (isBenignStreamError(err)) {
    return
  }

  try {
    console.warn(`[Main] Ignoring ${streamName} error:`, err)
  } catch {
    // Stream error handlers must never throw; they run on process-level diagnostics.
  }
}

export function installProcessStreamErrorHandlers(): void {
  process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
    handleProcessStreamError('stdout', err)
  })

  process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
    handleProcessStreamError('stderr', err)
  })
}
