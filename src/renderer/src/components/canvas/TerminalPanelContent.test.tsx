import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const terminalCreate = vi.fn()
const terminalWrite = vi.fn()
const terminalResize = vi.fn()
const terminalKill = vi.fn()
const terminalGetCwd = vi.fn()
const terminalOnData = vi.fn(() => vi.fn())
const terminalOnExit = vi.fn(() => vi.fn())

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    textarea = document.createElement('textarea')
    loadAddon() {}
    open() {}
    focus() {}
    clear() {}
    write() {}
    dispose() {}
    onData() {
      return { dispose: vi.fn() }
    }
    onKey() {
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

import { TerminalPanelContent } from './TerminalPanelContent'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TerminalPanelContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    terminalWrite.mockResolvedValue(undefined)
    terminalResize.mockResolvedValue(undefined)
    terminalKill.mockResolvedValue(undefined)

    Object.defineProperty(window, 'electronAPI', {
      value: {
        ...(window.electronAPI ?? {}),
        terminal: {
          create: terminalCreate,
          write: terminalWrite,
          resize: terminalResize,
          kill: terminalKill,
          getCwd: terminalGetCwd,
          getBuffer: vi.fn(),
          onData: terminalOnData,
          onExit: terminalOnExit,
        },
      },
      configurable: true,
      writable: true,
    })

    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 480,
      top: 0,
      left: 0,
      right: 640,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('kills only the PTY instance that owned the cleanup', async () => {
    const firstCwd = deferred<{ cwd: string | null }>()
    const secondCwd = deferred<{ cwd: string | null }>()

    terminalCreate.mockResolvedValueOnce({ pid: 111 }).mockResolvedValueOnce({ pid: 222 })
    terminalGetCwd.mockImplementationOnce(() => firstCwd.promise).mockImplementationOnce(() => secondCwd.promise)

    const first = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(1)
    })

    first.unmount()

    const second = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(2)
    })

    expect(terminalGetCwd).toHaveBeenNthCalledWith(1, 'panel-1', 111)

    firstCwd.resolve({ cwd: '/tmp/one' })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 111)
    })

    second.unmount()
    expect(terminalGetCwd).toHaveBeenNthCalledWith(2, 'panel-1', 222)

    secondCwd.resolve({ cwd: '/tmp/two' })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 222)
    })
  })
})
