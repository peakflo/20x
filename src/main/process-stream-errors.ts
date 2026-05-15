const IGNORED_PROCESS_STREAM_ERROR_CODES = new Set(['EPIPE', 'EIO'])

export function handleProcessStreamError(
  streamName: 'stdout' | 'stderr',
  err: NodeJS.ErrnoException
): void {
  if (err.code && IGNORED_PROCESS_STREAM_ERROR_CODES.has(err.code)) {
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
