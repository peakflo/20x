import { readFile, realpath, stat, writeFile } from 'fs/promises'
import { basename, join, sep } from 'path'
import type { DatabaseManager } from './database'
import { renderScadFile } from './scad-preview'

const MAX_SCAD_BYTES = 1024 * 1024

async function attachmentPath(db: DatabaseManager, taskId: string, attachmentId: string): Promise<string> {
  const attachment = db.getTask(taskId)?.attachments.find((item) => item.id === attachmentId)
  if (!attachment || !attachment.filename.toLowerCase().endsWith('.scad')) throw new Error('SCAD attachment not found')
  const directory = await realpath(db.getAttachmentsDir(taskId))
  const path = await realpath(join(directory, `${attachment.id}-${basename(attachment.filename)}`))
  if (!path.startsWith(`${directory}${sep}`)) throw new Error('SCAD attachment not found')
  if (!(await stat(path)).isFile()) throw new Error('SCAD attachment not found')
  return path
}

export async function readScadAttachment(db: DatabaseManager, taskId: string, attachmentId: string): Promise<string> {
  const path = await attachmentPath(db, taskId, attachmentId)
  if ((await stat(path)).size > MAX_SCAD_BYTES) throw new Error('SCAD attachment is too large to edit')
  return readFile(path, 'utf8')
}

export async function saveScadAttachment(db: DatabaseManager, taskId: string, attachmentId: string, content: string, expectedContent: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_SCAD_BYTES) throw new Error('SCAD attachment is too large to edit')
  const path = await attachmentPath(db, taskId, attachmentId)
  if (await readFile(path, 'utf8') !== expectedContent) throw new Error('This SCAD file changed on disk. Reload it before you save.')
  await writeFile(path, content, 'utf8')
}

export async function renderScadAttachment(db: DatabaseManager, taskId: string, attachmentId: string): Promise<string> {
  return renderScadFile(await attachmentPath(db, taskId, attachmentId))
}
