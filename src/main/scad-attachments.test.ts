import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseManager } from './database'
import { readScadAttachment, saveScadAttachment } from './scad-attachments'

describe('SCAD task attachments', () => {
  let directory: string
  let db: DatabaseManager

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), '20x-scad-attachment-'))
    await writeFile(join(directory, 'attachment-1-case.scad'), 'cube(10);')
    db = {
      getTask: () => ({ attachments: [{ id: 'attachment-1', filename: 'case.scad' }] }),
      getAttachmentsDir: () => directory
    } as unknown as DatabaseManager
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('reads and saves the named attachment with a conflict check', async () => {
    expect(await readScadAttachment(db, 'task-1', 'attachment-1')).toBe('cube(10);')
    await saveScadAttachment(db, 'task-1', 'attachment-1', 'cube(12);', 'cube(10);')
    expect(await readFile(join(directory, 'attachment-1-case.scad'), 'utf8')).toBe('cube(12);')
    await expect(saveScadAttachment(db, 'task-1', 'attachment-1', 'cube(14);', 'cube(10);')).rejects.toThrow('changed on disk')
  })

  it('rejects an ID that is not in the task', async () => {
    await expect(readScadAttachment(db, 'task-1', 'other')).rejects.toThrow('not found')
  })
})
