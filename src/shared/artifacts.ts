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
