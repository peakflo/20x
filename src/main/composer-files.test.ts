import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboard as electronClipboard, nativeImage } from 'electron'
import { readFile, stat, unlink } from 'fs/promises'
import { readClipboardFilePaths, saveComposerImage } from './composer-files'

vi.mock('electron', () => ({
  clipboard: { read: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() }
}))
const clipboard = electronClipboard as unknown as Electron.Clipboard
const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map(path => unlink(path)))
  vi.resetAllMocks()
})

describe('composer file references', () => {
  it('reads all local Finder and URI-list paths, deduplicating formats without reading files', async () => {
    const mac = 'electron application/osclipboard;format="public.file-url"'
    const item = (values: Record<string, string>) => ({
      types: Object.keys(values), getType: async (type: string) => new Blob([values[type]])
    })
    vi.mocked(clipboard.read).mockResolvedValue([
      item({ [mac]: 'file:///tmp/product%20brief.pdf', 'image/png': 'thumbnail' }),
      item({ 'text/uri-list': '# comment\r\nfile:///tmp/product%20brief.pdf\r\nfile:///tmp/%E6%96%87.txt\r\nhttps://example.com' })
    ] as Electron.ClipboardItem[])
    expect(await readClipboardFilePaths()).toEqual(['/tmp/product brief.pdf', '/tmp/文.txt'])
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled()
  })

  it('does not interpret normal text as a file, and rejects nonlocal file URLs', async () => {
    vi.mocked(clipboard.read).mockResolvedValue([{ types: ['text/plain'] }] as Electron.ClipboardItem[])
    expect(await readClipboardFilePaths()).toEqual([])
    vi.mocked(clipboard.read).mockResolvedValue([{
      types: ['text/uri-list'], getType: async () => new Blob(['file://remote/share/file.txt'])
    }] as unknown as Electron.ClipboardItem[])
    await expect(readClipboardFilePaths()).rejects.toThrow('local file')
  })

  it('writes separate private PNG files and leaves them readable after returning', async () => {
    const png = Buffer.from('validated PNG')
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({ isEmpty: () => false, toPNG: () => png } as Electron.NativeImage)
    created.push(await saveComposerImage(new Uint8Array([1])), await saveComposerImage(new Uint8Array([1])))
    expect(created[0]).not.toBe(created[1])
    for (const path of created) {
      expect(path).toMatch(/20x-clipboard-[\w-]+\.png$/)
      expect(await readFile(path)).toEqual(png)
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects invalid, oversized, and undecodable image payloads before writing', async () => {
    for (const value of ['path', {}, new Uint8Array(), new Uint8Array(50 * 1024 * 1024 + 1)]) {
      await expect(saveComposerImage(value)).rejects.toThrow('50 MB')
    }
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled()
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({ isEmpty: () => true } as Electron.NativeImage)
    await expect(saveComposerImage(new Uint8Array([1]))).rejects.toThrow('could not be read')
  })
})
