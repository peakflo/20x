import { vi } from 'vitest'

// Suppress React act() warnings in happy-dom
;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// Mock the mobile API client
vi.mock('../src/mobile/api/client', () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({})
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined)
    },
    skills: {
      list: vi.fn().mockResolvedValue([])
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      start: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
      resume: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
      send: vi.fn().mockResolvedValue({ success: true }),
      approve: vi.fn().mockResolvedValue({ success: true }),
      sync: vi.fn().mockResolvedValue({ success: true, status: 'working' }),
      abort: vi.fn().mockResolvedValue({ success: true }),
      stop: vi.fn().mockResolvedValue({ success: true })
    },
    git: {
      getProvider: vi.fn().mockResolvedValue({ provider: 'github' })
    },
    github: {
      getOrg: vi.fn().mockResolvedValue({ org: '' }),
      getOrgs: vi.fn().mockResolvedValue([]),
      setOrg: vi.fn().mockResolvedValue({ org: '' }),
      fetchRepos: vi.fn().mockResolvedValue([])
    }
  }
}))

// Mock the mobile WebSocket module
vi.mock('../src/mobile/api/websocket', () => ({
  onEvent: vi.fn()
}))
