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
  updatedAt: number
  reloadTrigger: number
}

export interface ArtifactUIState {
  open: boolean
  activeTabId: string | null
  railExpanded: boolean
}
