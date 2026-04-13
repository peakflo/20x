import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0-test') }
}))

import { EnterpriseHeartbeat } from './enterprise-heartbeat'

describe('EnterpriseHeartbeat', () => {
  let heartbeat: EnterpriseHeartbeat
  let mockApiClient: { sendHeartbeat: ReturnType<typeof vi.fn>; getDomain: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockApiClient = {
      sendHeartbeat: vi.fn().mockResolvedValue({ ok: true, timestamp: new Date().toISOString() }),
      getDomain: vi.fn().mockReturnValue('api.peakflo.ai')
    }
    heartbeat = new EnterpriseHeartbeat(mockApiClient as never)
  })

  afterEach(() => {
    heartbeat.stop()
  })

  it('sends heartbeat immediately on start', () => {
    heartbeat.start({ userEmail: 'test@example.com' })

    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledTimes(1)
    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledWith({
      appVersion: '1.0.0-test',
      userEmail: 'test@example.com',
      userName: undefined
    })
  })

  it('reports isRunning correctly', () => {
    expect(heartbeat.isRunning).toBe(false)

    heartbeat.start()
    expect(heartbeat.isRunning).toBe(true)

    heartbeat.stop()
    expect(heartbeat.isRunning).toBe(false)
  })

  it('is idempotent — calling start() again restarts', () => {
    heartbeat.start({ userEmail: 'a@test.com' })
    heartbeat.start({ userEmail: 'b@test.com' })

    // Second start should have called sendHeartbeat with new email
    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledTimes(2)
    expect(mockApiClient.sendHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ userEmail: 'b@test.com' })
    )
  })

  it('passes appVersion from electron app', () => {
    heartbeat.start()

    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ appVersion: '1.0.0-test' })
    )
  })

  it('stop clears the interval', () => {
    heartbeat.start()
    expect(heartbeat.isRunning).toBe(true)

    heartbeat.stop()
    expect(heartbeat.isRunning).toBe(false)

    // Calling stop again is safe
    heartbeat.stop()
    expect(heartbeat.isRunning).toBe(false)
  })

  it('can update API client', () => {
    const newClient = {
      sendHeartbeat: vi.fn().mockResolvedValue({ ok: true, timestamp: new Date().toISOString() }),
      getDomain: vi.fn().mockReturnValue('api.peakflo.ai')
    }

    heartbeat.setApiClient(newClient as never)
    heartbeat.start()

    // Should use the new client
    expect(newClient.sendHeartbeat).toHaveBeenCalledTimes(1)
    expect(mockApiClient.sendHeartbeat).not.toHaveBeenCalled()
  })

  it('passes userName when provided', () => {
    heartbeat.start({ userEmail: 'test@example.com', userName: 'Test User' })

    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledWith({
      appVersion: '1.0.0-test',
      userEmail: 'test@example.com',
      userName: 'Test User'
    })
  })

  it('handles undefined options', () => {
    heartbeat.start()

    expect(mockApiClient.sendHeartbeat).toHaveBeenCalledWith({
      appVersion: '1.0.0-test',
      userEmail: undefined,
      userName: undefined
    })
  })

  it('includes domain name in error logs on heartbeat failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApiClient.sendHeartbeat.mockRejectedValue(new Error('Connection refused'))

    heartbeat.start()
    // Wait for the async sendHeartbeat to complete
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalled()
    })

    const failCall = warnSpy.mock.calls.find((c) => c[0].includes('[EnterpriseHeartbeat] Failed'))
    expect(failCall).toBeDefined()
    expect(failCall![0]).toContain('(domain: api.peakflo.ai)')
    expect(failCall![0]).toContain('Connection refused')

    warnSpy.mockRestore()
  })
})
