import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  computeMaintenanceStatus,
  harnessDisplayLabel,
  harnessUpdateChecksEnabled,
  parseVersionFromOutput,
  statusNeedsAttention
} from './harness-maintenance'

describe('parseVersionFromOutput', () => {
  it('extracts a version from free-form CLI output', () => {
    expect(parseVersionFromOutput('1.2.3 (Claude Code)')).toBe('1.2.3')
    expect(parseVersionFromOutput('codex-cli 0.21.0')).toBe('0.21.0')
    expect(parseVersionFromOutput('@opencode/cli 2.0.26')).toBe('2.0.26')
    expect(parseVersionFromOutput('pi 0.80.5')).toBe('0.80.5')
    expect(parseVersionFromOutput('cursor-agent 2024.11.8-abc123')).toBe('2024.11.8-abc123')
  })

  it('returns null when there is nothing version-like', () => {
    expect(parseVersionFromOutput('command not found')).toBeNull()
    expect(parseVersionFromOutput('')).toBeNull()
    expect(parseVersionFromOutput(null)).toBeNull()
    expect(parseVersionFromOutput(undefined)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares dotted numeric versions', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('ignores pre-release/build suffixes', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0)
    expect(compareVersions('2024.11.8-abc123', '2024.11.8')).toBe(0)
  })
})

describe('computeMaintenanceStatus', () => {
  it('reports not_installed when the harness is missing', () => {
    expect(computeMaintenanceStatus({ installed: false, version: null, latestVersion: null, requirement: {} })).toBe('not_installed')
  })

  it('reports unknown when installed but the version could not be parsed', () => {
    expect(computeMaintenanceStatus({ installed: true, version: null, latestVersion: '1.0.0', requirement: {} })).toBe('unknown')
  })

  it('reports unsupported below the bundled minimum, even offline', () => {
    expect(computeMaintenanceStatus({
      installed: true,
      version: '0.80.4',
      latestVersion: null,
      requirement: { minimum: '0.80.5', recommended: '0.84.0' }
    })).toBe('unsupported')
  })

  it('reports below_recommended between minimum and recommended', () => {
    expect(computeMaintenanceStatus({
      installed: true,
      version: '0.81.0',
      latestVersion: null,
      requirement: { minimum: '0.80.5', recommended: '0.84.0' }
    })).toBe('below_recommended')
  })

  it('reports unknown when the latest-version lookup failed and no requirement is violated', () => {
    expect(computeMaintenanceStatus({ installed: true, version: '1.5.0', latestVersion: null, requirement: {} })).toBe('unknown')
  })

  it('reports behind_latest when a newer version is published', () => {
    expect(computeMaintenanceStatus({ installed: true, version: '1.0.0', latestVersion: '1.1.0', requirement: {} })).toBe('behind_latest')
  })

  it('reports up_to_date at the latest version', () => {
    expect(computeMaintenanceStatus({ installed: true, version: '1.1.0', latestVersion: '1.1.0', requirement: {} })).toBe('up_to_date')
  })

  it('prefers the bundled requirement over a stale latest-version lookup', () => {
    // Below the recommended version even though it happens to equal "latest" (e.g. latest regressed, or cache is stale).
    expect(computeMaintenanceStatus({
      installed: true,
      version: '0.81.0',
      latestVersion: '0.81.0',
      requirement: { recommended: '0.84.0' }
    })).toBe('below_recommended')
  })
})

describe('statusNeedsAttention', () => {
  it('flags behind_latest, below_recommended and unsupported', () => {
    expect(statusNeedsAttention('behind_latest')).toBe(true)
    expect(statusNeedsAttention('below_recommended')).toBe(true)
    expect(statusNeedsAttention('unsupported')).toBe(true)
  })

  it('does not flag up_to_date, not_installed or unknown', () => {
    expect(statusNeedsAttention('up_to_date')).toBe(false)
    expect(statusNeedsAttention('not_installed')).toBe(false)
    expect(statusNeedsAttention('unknown')).toBe(false)
  })
})

describe('harnessUpdateChecksEnabled', () => {
  it('defaults to enabled', () => {
    expect(harnessUpdateChecksEnabled(undefined)).toBe(true)
    expect(harnessUpdateChecksEnabled(null)).toBe(true)
    expect(harnessUpdateChecksEnabled('true')).toBe(true)
  })

  it('is disabled only when explicitly set to false', () => {
    expect(harnessUpdateChecksEnabled('false')).toBe(false)
  })
})

describe('harnessDisplayLabel', () => {
  it('matches the shared harness-instances labels', () => {
    expect(harnessDisplayLabel('claude-code')).toBe('Claude Code')
    expect(harnessDisplayLabel('codex')).toBe('Codex')
    expect(harnessDisplayLabel('opencode')).toBe('OpenCode')
    expect(harnessDisplayLabel('pi')).toBe('Pi')
    expect(harnessDisplayLabel('cursor')).toBe('Cursor')
  })
})
