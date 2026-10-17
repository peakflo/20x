/**
 * Harness maintenance: version checks and "Update now" for user-installed
 * harness CLIs (Claude Code, Codex, OpenCode, Pi; Cursor shows as bundled).
 *
 * Types, channel names and pure status/version logic live here so the
 * renderer, mobile client and main process agree on one shape. The actual
 * detection (spawning `which`/`where`, npm registry + Homebrew lookups,
 * running an update) is main-process-only — see `src/main/harness-maintenance/`.
 *
 * Renderer, main and mobile share this file. Keep Node and Electron imports out.
 */

import { harnessTypeLabel } from './harness-instances'
import type { HarnessKey, HarnessVersionRequirement } from './harness-versions'

export type { HarnessKey }

/** Display label for a harness key, e.g. "claude-code" -> "Claude Code". */
export function harnessDisplayLabel(harness: HarnessKey): string {
  return harnessTypeLabel(harness)
}

/**
 * How a harness binary got onto this machine, and therefore how (or whether)
 * 20x can update it with one click.
 *
 * `acp-registry` is reserved for the future ACP Registry agent update flow
 * (a separate subtask) — not implemented here.
 */
export type InstallerKind =
  | 'native'
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'homebrew-formula'
  | 'homebrew-cask'
  | 'manual'
  | 'bundled'
  | 'acp-registry'
  | 'unknown'

export type HarnessMaintenanceStatusValue =
  | 'up_to_date'
  | 'behind_latest'
  | 'below_recommended'
  | 'unsupported'
  | 'not_installed'
  | 'unknown'

/** One harness's version-check result, as shown in Settings → Agents and mobile. */
export interface HarnessMaintenanceStatus {
  harness: HarnessKey
  installed: boolean
  /** Resolved (symlink-followed) path to the binary, or null if not found. */
  binaryPath: string | null
  version: string | null
  /** null when the lookup failed, was skipped (setting off), or hasn't run yet. */
  latestVersion: string | null
  status: HarnessMaintenanceStatusValue
  installer: InstallerKind
  canUpdate: boolean
  /** Human-readable command for display/copy — not necessarily the literal argv run. */
  updateCommand: string | null
  checkedAt: string
  error?: string
  /** True when a session of this harness is currently running; the UI shows a restart notice. */
  hasActiveSession?: boolean
}

export type HarnessUpdateRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unchanged'

/** Progress/result of one in-flight or finished update run. */
export interface HarnessUpdateRunState {
  harness: HarnessKey
  status: HarnessUpdateRunStatus
  message?: string
  output?: string
  startedAt: string
  finishedAt?: string
}

/** Result of a single harness update, returned by the `:update` IPC/REST call. */
export interface HarnessUpdateResult {
  harness: HarnessKey
  run: HarnessUpdateRunState
  newStatus: HarnessMaintenanceStatus
}

/** Result of "Update all". */
export interface HarnessUpdateAllResult {
  results: HarnessUpdateResult[]
  skipped: HarnessKey[]
}

/** Broadcast whenever harness statuses are (re)computed — desktop and mobile both listen. */
export const HARNESS_MAINTENANCE_UPDATED_CHANNEL = 'harness-maintenance:updated'
/** Broadcast with live progress while an update runs. */
export const HARNESS_MAINTENANCE_PROGRESS_CHANNEL = 'harness-maintenance:progress'

/** Settings key for "Check for harness updates" (default on). Stored as `'true'`/`'false'`. */
export const HARNESS_UPDATE_CHECKS_SETTING_KEY = 'harness_update_checks_enabled'

/** Passive re-check cadence while the app is open. */
export const HARNESS_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Reads the `harness_update_checks_enabled` setting value; default is on. */
export function harnessUpdateChecksEnabled(settingValue: string | null | undefined): boolean {
  return settingValue !== 'false'
}

/**
 * Extract a semver-ish version from free-form `--version` output, e.g.
 * "1.2.3 (Claude Code)" -> "1.2.3", "codex-cli 0.21.0" -> "0.21.0",
 * "@opencode/cli 2.0.26" -> "2.0.26". Returns null when nothing looks like a version.
 */
export function parseVersionFromOutput(raw: string | null | undefined): string | null {
  if (!raw) return null
  const match = String(raw).match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/)
  return match ? match[1] : null
}

/** The dotted numeric prefix of a version string, ignoring any `-pre`/`+build` suffix. */
function numericParts(version: string): number[] {
  const core = version.split(/[-+]/)[0] ?? ''
  return core.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/**
 * Compares two version strings by their numeric dotted parts (pre-release/build
 * suffixes are ignored). Returns -1/0/1. Not a full semver comparator — good
 * enough for the plain `X.Y.Z` versions these CLIs publish.
 */
export function compareVersions(a: string, b: string): number {
  const pa = numericParts(a)
  const pb = numericParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Pure status computation: bundled minimum/recommended requirements always
 * win over the (possibly unavailable) network-sourced latest version, so a
 * harness below 20x's recommended version is flagged even fully offline.
 */
export function computeMaintenanceStatus(args: {
  installed: boolean
  version: string | null
  latestVersion: string | null
  requirement: HarnessVersionRequirement
}): HarnessMaintenanceStatusValue {
  const { installed, version, latestVersion, requirement } = args
  if (!installed) return 'not_installed'
  if (!version) return 'unknown'
  if (requirement.minimum && compareVersions(version, requirement.minimum) < 0) return 'unsupported'
  if (requirement.recommended && compareVersions(version, requirement.recommended) < 0) return 'below_recommended'
  if (!latestVersion) return 'unknown'
  if (compareVersions(version, latestVersion) < 0) return 'behind_latest'
  return 'up_to_date'
}

/** Whether a status is worth surfacing a dot/notice for. */
export function statusNeedsAttention(status: HarnessMaintenanceStatusValue): boolean {
  return status === 'behind_latest' || status === 'below_recommended' || status === 'unsupported'
}
