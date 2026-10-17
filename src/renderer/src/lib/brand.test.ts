import { describe, expect, it } from 'vitest'
import { desktopBrandName, displayMcpServerName } from './brand'

describe('visible desktop name', () => {
  it('uses the selected build flag without changing the old default', () => {
    expect(desktopBrandName('Workflo', false)).toBe('Workflo')
    expect(desktopBrandName('Peakflo Workflo', true)).toBe('Spaces')
  })

  it('changes only the enterprise workspace display label', () => {
    const server = { name: '[Workflo] Organisation Workspace', source: 'enterprise' }
    expect(displayMcpServerName(server)).toBe('[Workflo] Organisation Workspace')
    const prior = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { app: { brandSpacesEnabled: () => true } }
    })
    expect(displayMcpServerName(server)).toBe('[Spaces] Organisation Workspace')
    expect(displayMcpServerName({ ...server, source: 'user' })).toBe(server.name)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: prior })
  })
})
