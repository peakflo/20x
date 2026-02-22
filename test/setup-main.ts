import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/pf-desktop-test'),
    getName: vi.fn(() => 'pf-desktop'),
    getVersion: vi.fn(() => '1.0.0')
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
  BrowserWindow: vi.fn(),
  Notification: Object.assign(
    vi.fn().mockImplementation(function(this: any) {
      this.show = vi.fn()
      this.on = vi.fn()
    }),
    { isSupported: vi.fn().mockReturnValue(true) }
  )
}))
