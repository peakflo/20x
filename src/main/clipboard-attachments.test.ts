import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  isStagedClipboardFile,
  removeStagedClipboardFile,
  sanitizeAttachmentFilename,
  writeClipboardAttachment
} from './clipboard-attachments'
import { MAX_PASTED_ATTACHMENT_BYTES } from '../shared/clipboard-attachments'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clip-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sanitizeAttachmentFilename', () => {
  it('strips directories and characters invalid on any OS', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAttachmentFilename('C:\\Users\\me\\a:b?.png')).toBe('a_b_.png')
    expect(sanitizeAttachmentFilename('')).toBe('pasted-file')
    expect(sanitizeAttachmentFilename('..')).toBe('pasted-file')
  })
})

describe('writeClipboardAttachment', () => {
  it('writes the bytes to a unique staged path and cleans it up after save', () => {
    const path = writeClipboardAttachment(root, 'pasted-image.png', new Uint8Array([137, 80, 78, 71]))
    expect(path.endsWith('pasted-image.png')).toBe(true)
    expect(Array.from(readFileSync(path))).toEqual([137, 80, 78, 71])
    expect(isStagedClipboardFile(root, path)).toBe(true)

    removeStagedClipboardFile(root, path)
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('never removes files outside the staging root', () => {
    const outside = join(tmpdir(), 'not-staged.png')
    expect(isStagedClipboardFile(root, outside)).toBe(false)
    expect(isStagedClipboardFile(root, root)).toBe(false)
  })

  it('rejects empty and oversized data', () => {
    expect(() => writeClipboardAttachment(root, 'a.png', new Uint8Array())).toThrow(/empty/)
    expect(() => writeClipboardAttachment(root, 'a.png', new Uint8Array(MAX_PASTED_ATTACHMENT_BYTES + 1))).toThrow(/too large/)
  })
})
