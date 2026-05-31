import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReaddirSync = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  readdirSync: mockReaddirSync
}))

import { getWindowsPathEntries, prependMissingWindowsPaths } from './windows-runtime-paths'

describe('windows runtime paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prepends discovered Python install directories ahead of the existing PATH', () => {
    mockReaddirSync.mockReturnValue([
      { name: 'Python311', isDirectory: () => true },
      { name: 'Python39', isDirectory: () => true },
      { name: 'not-python', isDirectory: () => true }
    ])

    const entries = getWindowsPathEntries({
      USERPROFILE: 'C:\\Users\\alice',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'
    })

    expect(entries).toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python311')
    expect(entries).toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python311\\Scripts')
    expect(entries).toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python39')
    expect(entries).not.toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\not-python')
  })

  it('does not duplicate path entries that already exist with different casing', () => {
    const updatedPath = prependMissingWindowsPaths(
      'C:\\Program Files\\Git\\cmd;C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python311',
      [
        'c:\\program files\\git\\cmd',
        'C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python311',
        'C:\\Users\\alice\\AppData\\Roaming\\npm'
      ]
    )

    expect(updatedPath).toBe(
      'C:\\Users\\alice\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd;C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python311'
    )
  })
})
