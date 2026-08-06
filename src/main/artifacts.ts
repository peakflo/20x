import { readdir, readFile, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve, sep, win32 } from 'path'
import {
  ArtifactContentKind,
  ArtifactType,
  type ArtifactContent,
  type ArtifactFileEntry
} from '../shared/artifacts'

const MAX_SCAN_DEPTH = 10
const MAX_SCAN_FILES = 500
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const EXCLUDED_DIRECTORIES = new Set([
  '.agents',
  '.claude',
  '.git',
  '.opencode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
])

const EXCLUDED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx'])
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}
const HTML_EXTENSIONS = new Set(['.htm', '.html'])
const TEXT_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsx': 'text/javascript',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.toml': 'text/plain',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

function artifactTypeForPath(filePath: string): ArtifactType | null {
  const extension = extname(filePath).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extension)) return ArtifactType.MARKDOWN
  if (extension in IMAGE_MIME_TYPES) return ArtifactType.IMAGE
  if (HTML_EXTENSIONS.has(extension)) return ArtifactType.HTML
  if (extension in TEXT_MIME_TYPES) return ArtifactType.FILE
  return null
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

async function resolveArtifactPath(workspaceDir: string, artifactPath: string, allowAbsolute = false): Promise<string | null> {
  if (!artifactPath || artifactPath.includes('\0') || (!allowAbsolute && (isAbsolute(artifactPath) || win32.isAbsolute(artifactPath)))) {
    return null
  }

  let rootPath: string
  let candidatePath: string
  try {
    rootPath = await realpath(workspaceDir)
    candidatePath = await realpath(allowAbsolute && isAbsolute(artifactPath) ? artifactPath : resolve(rootPath, artifactPath))
  } catch {
    return null
  }

  return isWithinRoot(rootPath, candidatePath) ? candidatePath : null
}

/** Resolve one tool-reported write path into a previewable workspace artifact.
 * Unlike renderer reads this accepts absolute paths, but still rejects anything
 * outside the task workspace after resolving symlinks. */
export async function inspectTaskArtifact(workspaceDir: string, artifactPath: string): Promise<ArtifactFileEntry | null> {
  const filePath = await resolveArtifactPath(workspaceDir, artifactPath, true)
  if (!filePath) return null

  const type = artifactTypeForPath(filePath)
  if (!type) return null

  try {
    const rootPath = await realpath(workspaceDir)
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return null
    return {
      path: relative(rootPath, filePath).split(sep).join('/'),
      title: filePath.split(sep).pop() || artifactPath,
      type,
      updatedAt: fileStat.mtimeMs,
      size: fileStat.size
    }
  } catch {
    return null
  }
}

/**
 * Discover previewable files in a task workspace. The scan is deliberately
 * bounded and does not traverse symlinks or dependency/build directories.
 */
export async function scanTaskArtifacts(workspaceDir: string): Promise<ArtifactFileEntry[]> {
  let rootPath: string
  try {
    rootPath = await realpath(workspaceDir)
  } catch {
    return []
  }

  const artifacts: ArtifactFileEntry[] = []

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || artifacts.length >= MAX_SCAN_FILES) return

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (artifacts.length >= MAX_SCAN_FILES) break
      if (entry.isSymbolicLink()) continue

      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(absolutePath, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (directory === rootPath && EXCLUDED_ROOT_FILES.has(entry.name)) continue

      const type = artifactTypeForPath(entry.name)
      if (!type) continue

      try {
        const fileStat = await stat(absolutePath)
        if (!fileStat.isFile()) continue
        artifacts.push({
          path: relative(rootPath, absolutePath).split(sep).join('/'),
          title: entry.name,
          type,
          updatedAt: fileStat.mtimeMs,
          size: fileStat.size
        })
      } catch {
        // A file can disappear while an agent is replacing it. Ignore it and
        // let the next hydration/refresh discover the replacement.
      }
    }
  }

  await visit(rootPath, 0)
  return artifacts.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
}

/** Read a previewable artifact while enforcing task-workspace containment. */
export async function readTaskArtifact(workspaceDir: string, artifactPath: string): Promise<ArtifactContent | null> {
  const filePath = await resolveArtifactPath(workspaceDir, artifactPath)
  if (!filePath) return null

  const type = artifactTypeForPath(filePath)
  if (!type) return null

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }
  if (!fileStat.isFile()) return null

  const extension = extname(filePath).toLowerCase()
  try {
    if (type === ArtifactType.IMAGE) {
      if (fileStat.size > MAX_IMAGE_BYTES) return null
      const data = await readFile(filePath)
      const mimeType = IMAGE_MIME_TYPES[extension]
      return {
        kind: ArtifactContentKind.DATA_URL,
        content: `data:${mimeType};base64,${data.toString('base64')}`,
        mimeType
      }
    }

    if (fileStat.size > MAX_TEXT_BYTES) return null
    const content = await readFile(filePath, 'utf8')
    const mimeType = HTML_EXTENSIONS.has(extension) ? 'text/html' : TEXT_MIME_TYPES[extension] || 'text/plain'
    return { kind: ArtifactContentKind.TEXT, content, mimeType }
  } catch {
    return null
  }
}

export const ARTIFACT_FILE_LIMITS = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxScanDepth: MAX_SCAN_DEPTH,
  maxScanFiles: MAX_SCAN_FILES,
  maxTextBytes: MAX_TEXT_BYTES
} as const
