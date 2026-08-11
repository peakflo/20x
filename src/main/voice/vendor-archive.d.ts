/**
 * Minimal declarations for the two archive helpers.
 *
 * Neither package ships types and neither has a DefinitelyTyped package worth
 * adding for four functions. Only the parts `voice-tts-model-manager.ts` uses
 * are declared, so an unused corner of either API cannot be called by mistake.
 */

declare module 'unbzip2-stream' {
  import type { Duplex } from 'stream'
  /** Decompresses a bzip2 byte stream. */
  export default function unbzip2Stream(): Duplex
}

declare module 'tar-stream' {
  import type { Duplex, PassThrough, Readable } from 'stream'

  export interface TarHeader {
    name: string
    size?: number
    type?: 'file' | 'directory' | 'symlink' | 'link' | 'character-device' | 'block-device' | 'fifo' | 'contiguous-file' | 'pax-header' | 'pax-global-header' | 'gnu-long-link-path' | 'gnu-long-path' | null
    mode?: number
    mtime?: Date
  }

  export interface TarExtract extends Duplex {
    on(event: 'entry', listener: (header: TarHeader, stream: PassThrough, next: () => void) => void): this
    on(event: 'finish', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: string, listener: (...args: never[]) => void): this
  }

  export function extract(): TarExtract
  export function pack(): Readable
}
