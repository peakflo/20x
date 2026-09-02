import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboard as electronClipboard, nativeImage } from 'electron'
import { ArtifactClipboardMode } from '../shared/artifacts'
import { writeArtifactFileToClipboard } from './artifact-clipboard'

/** Mirrors the payload shape of the Electron ClipboardItem constructor. */
const { FakeClipboardItem } = vi.hoisted(() => ({
  FakeClipboardItem: class {
    constructor(public readonly items: Record<string, unknown>) {}
  }
}))

vi.mock('electron', () => ({
  clipboard: {
    write: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn().mockResolvedValue(undefined)
  },
  ClipboardItem: FakeClipboardItem,
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true }))
  }
}))

const clipboard = electronClipboard as unknown as Electron.Clipboard
const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function writtenItems(): Record<string, unknown> {
  const [item] = vi.mocked(clipboard.write).mock.calls[0][0]
  return (item as unknown as InstanceType<typeof FakeClipboardItem>).items
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe('writeArtifactFileToClipboard', () => {
  it('puts a file URL on the macOS pasteboard so Finder can paste the file', async () => {
    setPlatform('darwin')

    await expect(writeArtifactFileToClipboard('/tmp/workspace/reports/summary.md')).resolves.toEqual({
      mode: ArtifactClipboardMode.FILE
    })
    expect(writtenItems()).toEqual({
      'electron application/osclipboard;format="public.file-url"': 'file:///tmp/workspace/reports/summary.md'
    })
  })

  it('puts a URI list on the Linux clipboard', async () => {
    setPlatform('linux')

    await expect(writeArtifactFileToClipboard('/tmp/workspace/reports/summary.md')).resolves.toEqual({
      mode: ArtifactClipboardMode.FILE
    })
    expect(writtenItems()).toEqual({ 'text/uri-list': 'file:///tmp/workspace/reports/summary.md\r\n' })
  })

  it('copies an image file as an image on Windows', async () => {
    setPlatform('win32')
    const image = { isEmpty: () => false, toPNG: () => Buffer.from('png-bytes') }
    vi.mocked(nativeImage.createFromPath).mockReturnValueOnce(image as unknown as Electron.NativeImage)

    await expect(writeArtifactFileToClipboard('C:\\workspace\\chart.png')).resolves.toEqual({
      mode: ArtifactClipboardMode.IMAGE
    })
    expect(Object.keys(writtenItems())).toEqual(['image/png'])
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('falls back to the file path on Windows for a file that is not an image', async () => {
    setPlatform('win32')

    await expect(writeArtifactFileToClipboard('C:\\workspace\\summary.md')).resolves.toEqual({
      mode: ArtifactClipboardMode.PATH
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('C:\\workspace\\summary.md')
    expect(clipboard.write).not.toHaveBeenCalled()
  })
})
