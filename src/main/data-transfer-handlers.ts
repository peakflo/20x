import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { mkdir, readdir, rm } from 'fs/promises'
import { basename, join } from 'path'
import { SCHEMA_VERSION, type DatabaseManager } from './database'
import {
  BUNDLE_EXTENSION,
  exportBundle,
  importBundle,
  readBundle,
  summarizeBundle,
  type ParsedBundle
} from './data-transfer'
import {
  DATA_CATEGORIES,
  type DataCategory,
  type DataExportResult,
  type DataImportPreview,
  type DataImportResult
} from '../shared/data-transfer'

/** Pre-import database backups kept in `<userData>/backups`. */
const KEPT_BACKUPS = 5

function validCategories(input: unknown): DataCategory[] {
  if (!Array.isArray(input)) return []
  return DATA_CATEGORIES.filter((c) => input.includes(c))
}

function dateStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function backupDatabase(db: DatabaseManager): Promise<string> {
  const dir = join(app.getPath('userData'), 'backups')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `pre-import-${dateStamp()}.db`)
  await db.db.backup(path)

  const old = (await readdir(dir))
    .filter((name) => name.startsWith('pre-import-') && name.endsWith('.db'))
    .sort()
    .slice(0, -KEPT_BACKUPS)
  for (const name of old) await rm(join(dir, name), { force: true })
  return path
}

export function registerDataTransferHandlers(db: DatabaseManager): void {
  // The file the user picked in data:pickImport. data:import only ever reads
  // this file, so the renderer cannot point the import at an arbitrary path.
  let pending: { path: string; bundle: ParsedBundle } | null = null

  ipcMain.handle('data:export', async (event, categories: unknown): Promise<DataExportResult> => {
    const picked = validCategories(categories)
    if (picked.length === 0) throw new Error('Pick at least one kind of data to export')

    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: 'Export 20x data',
      defaultPath: join(app.getPath('documents'), `20x-export-${dateStamp().slice(0, 10)}.${BUNDLE_EXTENSION}`),
      filters: [{ name: '20x export', extensions: [BUNDLE_EXTENSION] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }

    const exported = await exportBundle({
      db: db.db,
      userDataDir: app.getPath('userData'),
      outPath: result.filePath,
      categories: picked,
      appVersion: app.getVersion(),
      schemaVersion: SCHEMA_VERSION
    })
    return { canceled: false, path: exported.path, manifest: exported.manifest }
  })

  ipcMain.handle('data:pickImport', async (event): Promise<DataImportPreview | null> => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: 'Import 20x data',
      properties: ['openFile' as const],
      filters: [{ name: '20x export', extensions: [BUNDLE_EXTENSION] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const path = result.filePaths[0]
    const bundle = await readBundle(path)
    pending = { path, bundle }
    return { fileName: basename(path), manifest: bundle.manifest, categories: summarizeBundle(bundle) }
  })

  ipcMain.handle('data:cancelImport', () => {
    pending = null
  })

  ipcMain.handle('data:import', async (_, categories: unknown): Promise<DataImportResult> => {
    if (!pending) throw new Error('Choose an export file first')
    const { bundle } = pending
    pending = null

    return importBundle({
      db: db.db,
      userDataDir: app.getPath('userData'),
      bundle,
      categories: validCategories(categories),
      encryptEmptySecret: () =>
        safeStorage.isEncryptionAvailable() ? safeStorage.encryptString('') : Buffer.from('', 'utf8'),
      backup: () => backupDatabase(db)
    })
  })
}
