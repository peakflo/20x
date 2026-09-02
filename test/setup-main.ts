import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/pf-desktop-test'),
    getName: vi.fn(() => 'pf-desktop'),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn()
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn()
  },
  clipboard: {
    write: vi.fn(async () => undefined),
    writeText: vi.fn(async () => undefined),
    readText: vi.fn(async () => ''),
    clear: vi.fn()
  },
  ClipboardItem: class {
    constructor(public readonly items: Record<string, unknown>) {}
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }))
  },
  BrowserWindow: vi.fn(),
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false)
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true)
  },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => false)
  }
}))
