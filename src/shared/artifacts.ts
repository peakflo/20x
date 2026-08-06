export enum ArtifactType {
  MARKDOWN = 'markdown',
  IMAGE = 'image',
  HTML = 'html',
  PR = 'pr',
  FILE = 'file'
}

export enum ArtifactContentKind {
  TEXT = 'text',
  DATA_URL = 'data_url'
}

export enum PullRequestState {
  OPEN = 'open',
  CLOSED = 'closed',
  MERGED = 'merged'
}

export enum PullRequestReviewDecision {
  APPROVED = 'approved',
  CHANGES_REQUESTED = 'changes_requested',
  REVIEW_REQUIRED = 'review_required',
  NONE = 'none'
}

export enum PullRequestCheckState {
  PASSED = 'passed',
  FAILED = 'failed',
  PENDING = 'pending',
  SKIPPED = 'skipped'
}

export interface PullRequestCheck {
  name: string
  state: PullRequestCheckState
  url?: string
}

export interface PullRequestDetails {
  url: string
  repository: string
  number: number
  title: string
  body: string
  state: PullRequestState
  isDraft: boolean
  mergeStateStatus?: string
  reviewDecision: PullRequestReviewDecision
  author: { login: string; avatarUrl?: string; url?: string }
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  commentsCount: number
  reviewsCount: number
  createdAt: string
  updatedAt: string
  mergedAt?: string
  closedAt?: string
  checks: PullRequestCheck[]
}

export interface ArtifactFileEntry {
  path: string
  title: string
  type: ArtifactType
  updatedAt: number
  size: number
  /** Stable logical output identity. Multiple supporting files can belong to
   * one workpiece while `path` points at its selected preview entry file. */
  workpieceKey?: string
}

/** Metadata returned by the explicit artifact/workpiece tools. Files are
 * addressed relative to the artifact, never by an unrestricted workspace
 * path. */
export interface RegisteredArtifact {
  artifactId: string
  taskId: string
  title: string
  type: ArtifactType
  files: string[]
  entryFile?: string
  createdAt: number
  updatedAt: number
}

export interface ArtifactContent {
  kind: ArtifactContentKind
  content: string
  mimeType?: string
}

export interface ArtifactApi {
  scan: (taskId: string) => Promise<ArtifactFileEntry[]>
  read: (taskId: string, relativePath: string) => Promise<ArtifactContent | null>
}

export interface Artifact {
  id: string
  taskId: string
  type: ArtifactType
  title: string
  path?: string
  url?: string
  workpieceKey?: string
  updatedAt: number
  reloadTrigger: number
}

export interface ArtifactUIState {
  open: boolean
  activeTabId: string | null
  railExpanded: boolean
}

const PULL_REQUEST_URL_PATTERN = /https?:\/\/[^\s)\]>'"]+\/(?:pull|merge_requests)\/\d+(?:\b|\/)/i
const COMMAND_TOOL_PATTERN = /(?:^|[_:-])(bash|command|exec|shell|terminal)(?:$|[_:-])/

function pullRequestUrlIn(value: unknown): string | undefined {
  if (typeof value === 'string') return value.match(PULL_REQUEST_URL_PATTERN)?.[0]
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = pullRequestUrlIn(item)
      if (url) return url
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const url = pullRequestUrlIn(item)
      if (url) return url
    }
  }
  return undefined
}

/** Extract a PR created/reported by a tool without scraping arbitrary file or
 * transcript content. This prevents documentation examples from becoming
 * bogus artifacts when an agent reads source files. */
export function pullRequestUrlFromTool(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tool = value as Record<string, unknown>
  const status = typeof tool.status === 'string' ? tool.status.toLowerCase() : ''
  if (!['success', 'succeeded', 'complete', 'completed'].includes(status)) return undefined
  const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : ''
  const output = tool.output

  let parsedOutput: Record<string, unknown> | null = null
  if (output && typeof output === 'object' && !Array.isArray(output)) parsedOutput = output as Record<string, unknown>
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedOutput = parsed as Record<string, unknown>
    } catch { /* command output is normally plain text */ }
  }

  for (const key of ['prUrl', 'pr_url', 'pullRequestUrl', 'pull_request_url', 'html_url', 'web_url', 'url']) {
    const candidate = parsedOutput?.[key]
    if (typeof candidate === 'string') {
      const url = candidate.match(PULL_REQUEST_URL_PATTERN)?.[0]
      if (url) return url
    }
  }

  if (name.includes('pull_request') || name.includes('merge_request') || name.includes('create_pr')) {
    return pullRequestUrlIn(output)
  }

  if (!COMMAND_TOOL_PATTERN.test(name)) return undefined
  const text = typeof output === 'string'
    ? output
    : typeof parsedOutput?.stdout === 'string' ? parsedOutput.stdout : ''
  const standalone = text.match(/(?:^|\n)\s*(?:created\s+(?:pull request\s+)?)?(https?:\/\/[^\s)\]>'"]+\/(?:pull|merge_requests)\/\d+(?:\b|\/))\s*(?:\n|$)/i)
  return standalone?.[1]
}

/** Directories that form an explicit deliverable boundary. Files elsewhere in
 * a repository are code and belong in Changes, not in the artifact picker. */
const ARTIFACT_OUTPUT_DIRECTORIES = new Set([
  'artifacts',
  'deliverables',
  'outputs',
  'reports'
])

/**
 * Decide whether a workspace file is a logical user-facing deliverable.
 *
 * This mirrors Cloudflare OS's workpiece boundary: a file is not an artifact
 * merely because it can be previewed. Root preview files are treated as
 * standalone deliverables, while nested files require an explicit output
 * directory. Generic code/text files are allowed only inside that boundary.
 */
export function isArtifactDeliverablePath(path: string, type: ArtifactType): boolean {
  return artifactWorkpieceForPath(path, type) !== null
}

export interface ArtifactWorkpiece {
  key: string
  title: string
  grouped: boolean
}

/** Map an output path to its logical workpiece. A nested output folder is one
 * artifact even when it contains an HTML entry point plus many support files. */
export function artifactWorkpieceForPath(path: string, type: ArtifactType): ArtifactWorkpiece | null {
  const segments = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean)
  if (segments.length === 0) return null
  const directorySegments = segments.slice(0, -1)
  const boundaryIndex = directorySegments.findIndex((segment) => ARTIFACT_OUTPUT_DIRECTORIES.has(segment.toLowerCase()))

  if (boundaryIndex >= 0) {
    const groupName = segments[boundaryIndex + 1]
    const hasNamedGroup = boundaryIndex + 1 < segments.length - 1
    if (hasNamedGroup) {
      return {
        key: segments.slice(0, boundaryIndex + 2).join('/'),
        title: groupName,
        grouped: true
      }
    }
    return { key: segments.join('/'), title: segments.at(-1)!, grouped: false }
  }

  if (segments.length === 1 && type !== ArtifactType.FILE) {
    return { key: segments[0], title: segments[0], grouped: false }
  }
  return null
}
