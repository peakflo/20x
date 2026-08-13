import type { ChildProcess } from 'child_process'
import type { Writable } from 'stream'

/**
 * Pipe failures that are the normal consequence of the peer going away.
 *
 * A child process can exit at any moment. Anything already in flight towards
 * its stdin — or a socket the client has already closed — fails with one of
 * these codes. None of them mean the application is broken.
 */
const BENIGN_STREAM_ERROR_CODES = new Set([
  'EPIPE',
  'EIO',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END'
])

/** Marks a stream that already carries a guard, so guards are not stacked. */
const GUARDED = Symbol.for('20x.streamErrorGuardInstalled')

type Guardable = (NodeJS.WritableStream | NodeJS.ReadableStream) & {
  on?: (event: string, listener: (err: NodeJS.ErrnoException) => void) => unknown
  [GUARDED]?: boolean
}

/**
 * True when the error is a routine pipe or socket teardown rather than a fault.
 */
export function isBenignStreamError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === 'string' && BENIGN_STREAM_ERROR_CODES.has(code)
}

/**
 * Attaches an `error` listener to one stream.
 *
 * A Node stream with no `error` listener does not stay quiet: it re-throws on
 * the event loop, and in the Electron main process that is an uncaught
 * exception, a crash dialog, and a restart. Writing to a pipe whose child has
 * just exited is routine, so the error must land somewhere harmless.
 *
 * Note that a write callback does NOT replace this listener. Node calls the
 * callback AND emits `error` on the stream, so the callback alone still lets
 * the process fall over.
 */
export function guardStream(stream: Guardable | null | undefined, label: string): void {
  if (!stream || typeof stream.on !== 'function') return
  if (stream[GUARDED]) return

  try {
    Object.defineProperty(stream, GUARDED, { value: true, enumerable: false })
  } catch {
    // A frozen or proxied stream still gets its listener; only the marker fails.
  }

  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (isBenignStreamError(err)) return
    try {
      console.warn(`[${label}] stream error:`, err?.message ?? err)
    } catch {
      // Error handlers must never throw. The console can be gone too.
    }
  })
}

/**
 * Attaches error listeners to every pipe of a spawned child process.
 *
 * Call this immediately after `spawn`/`fork`, before the first write. Note that
 * `child.on('error')` does NOT cover this: that event reports a failure to
 * spawn, never a failure to write to a pipe after the child has gone.
 */
export function guardChildStreams(child: ChildProcess | null | undefined, label: string): void {
  if (!child) return
  guardStream(child.stdin as Guardable | null, `${label}/stdin`)
  guardStream(child.stdout as Guardable | null, `${label}/stdout`)
  guardStream(child.stderr as Guardable | null, `${label}/stderr`)
}

/**
 * Writes to a child's stdin and never throws.
 *
 * Returns true when the data was handed to the pipe. A false result means the
 * child had already gone; that is an expected outcome, not a fault.
 */
export function writeToChildStdin(
  child: ChildProcess | null | undefined,
  data: string | Uint8Array,
  label: string
): boolean {
  const stdin = child?.stdin as Writable | null | undefined
  if (!stdin || stdin.destroyed || stdin.writable === false) return false

  guardStream(stdin as unknown as Guardable, `${label}/stdin`)

  try {
    stdin.write(data, (err) => {
      if (!err || isBenignStreamError(err)) return
      try {
        console.warn(`[${label}] stdin write failed:`, err.message)
      } catch {
        // Nothing else can be reported safely.
      }
    })
    return true
  } catch {
    // The child went away between the writable check and the write itself.
    return false
  }
}
