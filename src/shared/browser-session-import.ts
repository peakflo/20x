export type BrowserSourceId = 'chrome' | 'edge' | 'brave' | 'arc' | 'firefox' | 'safari'

export interface BrowserImportProfile {
  id: string
  name: string
}

export interface BrowserImportSource {
  id: BrowserSourceId
  name: string
  profiles: BrowserImportProfile[]
}

export interface BrowserImportRequest {
  browserId: BrowserSourceId
  profileId: string
  domains: string[]
}

export interface BrowserImportResult {
  imported: number
  skipped: number
  byDomain: Record<string, number>
}
