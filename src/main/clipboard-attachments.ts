/**
 * Staging area for files pasted from the clipboard that have no path on disk
 * (screenshots, images copied from a browser). The renderer sends their bytes
 * here; they are written to a temp file so the regular path-based attachment
 * pipeline (`attachments:save`, pending task-form files) can pick them up.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, relative, isAbsolute, dirname } from 'path'
import { randomUUID } from 'crypto'
import { MAX_PASTED_ATTACHMENT_BYTES } from '../shared/clipboard-attachments'

/** Staged files older than this are removed on the next write. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Strip directories and characters that are invalid on Windows/macOS/Linux. */
export function sanitizeAttachmentFilename(name: string): string {
  const base = basename(String(name ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').trim()
  return (cleaned || 'pasted-file').slice(0, 200)
}

function removeStaleEntries(root: string, now: number): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(root, entry)
    try {
      if (now - statSync(full).mtimeMs > STALE_AFTER_MS) rmSync(full, { recursive: true, force: true })
    } catch {
      // Best effort cleanup only.
    }
  }
}

/** Write pasted bytes to `<root>/<uuid>/<filename>` and return the path. */
export function writeClipboardAttachment(root: string, filename: string, data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength === 0) throw new Error('Pasted file is empty')
  if (bytes.byteLength > MAX_PASTED_ATTACHMENT_BYTES) {
    throw new Error(`Pasted file is too large (max ${Math.round(MAX_PASTED_ATTACHMENT_BYTES / (1024 * 1024))} MB)`)
  }
  removeStaleEntries(root, Date.now())
  const dir = join(root, randomUUID())
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, sanitizeAttachmentFilename(filename))
  writeFileSync(filePath, bytes)
  return filePath
}

/** True when `filePath` lives inside the clipboard staging root. */
export function isStagedClipboardFile(root: string, filePath: string): boolean {
  const rel = relative(root, filePath)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Remove a staged file's private directory once it has been copied. */
export function removeStagedClipboardFile(root: string, filePath: string): void {
  if (!isStagedClipboardFile(root, filePath)) return
  try {
    rmSync(dirname(filePath), { recursive: true, force: true })
  } catch {
    // Best effort cleanup only.
  }
}
