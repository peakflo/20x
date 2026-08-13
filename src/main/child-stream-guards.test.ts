import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, Writable } from 'stream'
import type { ChildProcess } from 'child_process'
import {
  guardChildStreams,
  guardStream,
  isBenignStreamError,
  writeToChildStdin
} from './child-stream-guards'

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code })
}

/** A stdin whose async write always fails, like a pipe whose child has exited. */
function deadPipe(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb(errnoError('EPIPE'))
    }
  })
}

function fakeChild(stdin: Writable | null): ChildProcess {
  return { stdin, stdout: null, stderr: null } as unknown as ChildProcess
}

describe('isBenignStreamError', () => {
  it.each(['EPIPE', 'EIO', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])(
    'treats %s as benign',
    (code) => {
      expect(isBenignStreamError(errnoError(code))).toBe(true)
    }
  )

  it.each([
    ['a real fault', errnoError('EACCES')],
    ['an error without a code', new Error('boom')],
    ['null', null],
    ['undefined', undefined]
  ])('does not treat %s as benign', (_label, value) => {
    expect(isBenignStreamError(value)).toBe(false)
  })
})

describe('guardStream', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('swallows a benign error that would otherwise be unhandled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = new PassThrough()

    guardStream(stream, 'test')

    expect(() => stream.emit('error', errnoError('EPIPE'))).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs a real fault instead of hiding it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = new PassThrough()

    guardStream(stream, 'test')
    stream.emit('error', errnoError('EACCES'))

    expect(warnSpy).toHaveBeenCalledWith('[test] stream error:', 'write EACCES')
  })

  it('is idempotent, so repeated calls do not stack listeners', () => {
    const stream = new PassThrough()

    guardStream(stream, 'test')
    guardStream(stream, 'test')

    expect(stream.listenerCount('error')).toBe(1)
  })

  it('does nothing when the stream is absent', () => {
    expect(() => guardStream(null, 'test')).not.toThrow()
    expect(() => guardStream(undefined, 'test')).not.toThrow()
  })

  /**
   * The invariant this whole module exists for. Without a guard an `error`
   * event on a stream is re-thrown by EventEmitter, which in the Electron main
   * process is an uncaught exception, a crash dialog, and a restart.
   */
  it('proves the invariant: an unguarded stream throws on the same error', () => {
    const unguarded = new PassThrough()

    expect(() => unguarded.emit('error', errnoError('EPIPE'))).toThrow(/EPIPE/)
  })
})

describe('guardChildStreams', () => {
  it('guards stdin, stdout and stderr', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin, stdout, stderr } as unknown as ChildProcess

    guardChildStreams(child, 'test')

    for (const stream of [stdin, stdout, stderr]) {
      expect(stream.listenerCount('error')).toBe(1)
      expect(() => stream.emit('error', errnoError('EPIPE'))).not.toThrow()
    }
  })

  it('tolerates a child with no pipes and a missing child', () => {
    expect(() => guardChildStreams(fakeChild(null), 'test')).not.toThrow()
    expect(() => guardChildStreams(null, 'test')).not.toThrow()
  })
})

describe('writeToChildStdin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not crash when the pipe fails asynchronously with EPIPE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stdin = deadPipe()

    expect(writeToChildStdin(fakeChild(stdin), 'payload\n', 'test')).toBe(true)

    // The failure arrives after write() returns, on a later tick.
    await new Promise((resolve) => setImmediate(resolve))

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('reports a genuine write fault without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(errnoError('EACCES'))
      }
    })
    guardStream(stdin, 'test/stdin')

    writeToChildStdin(fakeChild(stdin), 'payload\n', 'test')
    await new Promise((resolve) => setImmediate(resolve))

    expect(warnSpy).toHaveBeenCalledWith('[test] stdin write failed:', 'write EACCES')
  })

  it('returns false and writes nothing when the child has gone', () => {
    const stdin = new PassThrough()
    stdin.destroy()

    expect(writeToChildStdin(fakeChild(stdin), 'payload\n', 'test')).toBe(false)
    expect(writeToChildStdin(fakeChild(null), 'payload\n', 'test')).toBe(false)
    expect(writeToChildStdin(null, 'payload\n', 'test')).toBe(false)
  })

  it('returns false when the write throws synchronously', () => {
    const stdin = {
      destroyed: false,
      writable: true,
      on: () => stdin,
      write: () => {
        throw errnoError('ERR_STREAM_DESTROYED')
      }
    }

    expect(
      writeToChildStdin(fakeChild(stdin as unknown as Writable), 'payload\n', 'test')
    ).toBe(false)
  })
})
