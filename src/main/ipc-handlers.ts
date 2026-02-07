import { ipcMain, dialog, shell, Notification } from 'electron'
import { copyFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import type {
  DatabaseManager,
  CreateTaskData,
  UpdateTaskData,
  FileAttachmentRecord,
  CreateAgentData,
  UpdateAgentData
} from './database'

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.md': 'text/markdown'
}

function getMimeType(filename: string): string {
  return MIME_MAP[extname(filename).toLowerCase()] || 'application/octet-stream'
}

export function registerIpcHandlers(db: DatabaseManager): void {
  ipcMain.handle('db:getTasks', () => {
    return db.getTasks()
  })

  ipcMain.handle('db:getTask', (_, id: string) => {
    return db.getTask(id)
  })

  ipcMain.handle('db:createTask', (_, data: CreateTaskData) => {
    return db.createTask(data)
  })

  ipcMain.handle('db:updateTask', (_, id: string, data: UpdateTaskData) => {
    return db.updateTask(id, data)
  })

  ipcMain.handle('db:deleteTask', (_, id: string) => {
    return db.deleteTask(id)
  })

  // Attachment handlers
  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(
    'attachments:save',
    (_, taskId: string, filePath: string): FileAttachmentRecord => {
      const id = crypto.randomUUID()
      const filename = basename(filePath)
      const stat = statSync(filePath)
      const dir = db.getAttachmentsDir(taskId)
      const destPath = join(dir, `${id}-${filename}`)

      copyFileSync(filePath, destPath)

      return {
        id,
        filename,
        size: stat.size,
        mime_type: getMimeType(filename),
        added_at: new Date().toISOString()
      }
    }
  )

  ipcMain.handle('attachments:remove', (_, taskId: string, attachmentId: string) => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) return

    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    if (match) unlinkSync(join(dir, match))
  })

  ipcMain.handle('attachments:open', (_, taskId: string, attachmentId: string) => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) return

    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    if (match) shell.openPath(join(dir, match))
  })

  // Notification handler
  ipcMain.handle('notifications:show', (_, title: string, body: string) => {
    new Notification({ title, body }).show()
  })

  // Agent handlers
  ipcMain.handle('agent:getAll', () => {
    return db.getAgents()
  })

  ipcMain.handle('agent:get', (_, id: string) => {
    return db.getAgent(id)
  })

  ipcMain.handle('agent:create', (_, data: CreateAgentData) => {
    return db.createAgent(data)
  })

  ipcMain.handle('agent:update', (_, id: string, data: UpdateAgentData) => {
    return db.updateAgent(id, data)
  })

  ipcMain.handle('agent:delete', (_, id: string) => {
    return db.deleteAgent(id)
  })
}
