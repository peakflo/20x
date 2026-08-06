import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'path'
import { randomUUID } from 'crypto'
import {
  ArtifactContentKind,
  ArtifactType,
  artifactWorkpieceForPath,
  type Artifact,
  type ArtifactContent,
  type ArtifactFileEntry,
  type RegisteredArtifact
} from '../shared/artifacts'

const MAX_SCAN_DEPTH = 10
const MAX_SCAN_FILES = 500
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const REGISTRY_VERSION = 1
const REGISTRY_DIRECTORY = '.20x'
const REGISTRY_FILENAME = 'artifacts.json'
const ARTIFACT_FILES_DIRECTORY = 'artifacts'

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

const EXCLUDED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'heartbeat.md'])

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

export function artifactTypeForPath(filePath: string): ArtifactType | null {
  const extension = extname(filePath).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extension)) return ArtifactType.MARKDOWN
  if (extension in IMAGE_MIME_TYPES) return ArtifactType.IMAGE
  if (HTML_EXTENSIONS.has(extension)) return ArtifactType.HTML
  if (extension in TEXT_MIME_TYPES) return ArtifactType.FILE
  return null
}

interface ArtifactRegistryFile {
  version: number
  artifacts: RegisteredArtifact[]
}

const registryWrites = new Map<string, Promise<unknown>>()

function registryPath(workspaceDir: string): string {
  return resolve(workspaceDir, REGISTRY_DIRECTORY, REGISTRY_FILENAME)
}

function artifactRootPath(workspaceDir: string, artifactId: string): string {
  return resolve(workspaceDir, ARTIFACT_FILES_DIRECTORY, artifactId)
}

function normalizeArtifactFileName(filename: string): string | null {
  if (!filename || filename.includes('\0') || isAbsolute(filename) || win32.isAbsolute(filename)) return null
  const normalized = filename.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return normalized
}

function validateArtifactId(artifactId: string): boolean {
  return /^artifact_[a-z0-9][a-z0-9_-]{5,80}$/.test(artifactId)
}

function slugifyArtifactTitle(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'output'
}

async function readArtifactRegistry(workspaceDir: string): Promise<ArtifactRegistryFile> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(workspaceDir), 'utf8')) as Partial<ArtifactRegistryFile>
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.artifacts)) throw new Error('Unsupported artifact registry')
    return { version: REGISTRY_VERSION, artifacts: parsed.artifacts }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: REGISTRY_VERSION, artifacts: [] }
    throw error
  }
}

async function updateArtifactRegistry<T>(
  workspaceDir: string,
  updater: (registry: ArtifactRegistryFile) => Promise<T> | T
): Promise<T> {
  const previous = registryWrites.get(workspaceDir) || Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const registry = await readArtifactRegistry(workspaceDir)
    const result = await updater(registry)
    const directory = resolve(workspaceDir, REGISTRY_DIRECTORY)
    await mkdir(directory, { recursive: true })
    const temporaryPath = resolve(directory, `${REGISTRY_FILENAME}.${randomUUID()}.tmp`)
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, registryPath(workspaceDir))
    return result
  })
  registryWrites.set(workspaceDir, current)
  try {
    return await current
  } finally {
    if (registryWrites.get(workspaceDir) === current) registryWrites.delete(workspaceDir)
  }
}

function registeredArtifactPath(record: RegisteredArtifact): string | undefined {
  return record.entryFile
    ? `${ARTIFACT_FILES_DIRECTORY}/${record.artifactId}/${record.entryFile}`
    : undefined
}

export function registeredArtifactToArtifact(record: RegisteredArtifact): Artifact {
  const path = registeredArtifactPath(record)
  return {
    id: `${record.taskId}:workpiece:${encodeURIComponent(record.artifactId)}`,
    taskId: record.taskId,
    type: record.type,
    title: record.title,
    path,
    workpieceKey: record.artifactId,
    updatedAt: record.updatedAt,
    reloadTrigger: Math.floor(record.updatedAt)
  }
}

function registeredArtifactToEntry(record: RegisteredArtifact): ArtifactFileEntry | null {
  const path = registeredArtifactPath(record)
  if (!path) return null
  return {
    path,
    title: record.title,
    type: record.type,
    updatedAt: record.updatedAt,
    size: 0,
    workpieceKey: record.artifactId
  }
}

async function resolveRegisteredArtifactFile(
  workspaceDir: string,
  artifactId: string,
  filename: string,
  createParent: boolean
): Promise<{ relativeName: string; absolutePath: string } | null> {
  if (!validateArtifactId(artifactId)) return null
  const relativeName = normalizeArtifactFileName(filename)
  if (!relativeName) return null
  const workspaceRoot = await realpath(workspaceDir)
  const root = artifactRootPath(workspaceRoot, artifactId)
  if (createParent) await mkdir(dirname(resolve(root, relativeName)), { recursive: true })
  let canonicalRoot: string
  let canonicalParent: string
  try {
    canonicalRoot = await realpath(root)
    canonicalParent = await realpath(dirname(resolve(root, relativeName)))
  } catch {
    return null
  }
  if (!isWithinRoot(workspaceRoot, canonicalRoot) || !isWithinRoot(canonicalRoot, canonicalParent)) return null
  const absolutePath = resolve(canonicalParent, relativeName.split('/').at(-1)!)
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  return { relativeName, absolutePath }
}

export async function createRegisteredTaskArtifact(
  workspaceDir: string,
  taskId: string,
  input: { title: string; type: ArtifactType }
): Promise<RegisteredArtifact> {
  const title = input.title.trim()
  if (!title) throw new Error('Artifact title is required')
  if (input.type === ArtifactType.PR) throw new Error('PR artifacts are created from pull request URLs')
  const now = Date.now()
  const artifactId = `artifact_${slugifyArtifactTitle(title)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
  await mkdir(artifactRootPath(workspaceDir, artifactId), { recursive: true })
  return updateArtifactRegistry(workspaceDir, (registry) => {
    const record: RegisteredArtifact = {
      artifactId,
      taskId,
      title,
      type: input.type,
      files: [],
      createdAt: now,
      updatedAt: now
    }
    registry.artifacts.push(record)
    return record
  })
}

export async function listRegisteredTaskArtifacts(workspaceDir: string, taskId: string): Promise<RegisteredArtifact[]> {
  const registry = await readArtifactRegistry(workspaceDir)
  return registry.artifacts.filter((artifact) => artifact.taskId === taskId)
}

export async function writeRegisteredTaskArtifactFile(
  workspaceDir: string,
  taskId: string,
  input: { artifactId: string; filename: string; content: string; encoding?: 'utf8' | 'base64'; preview?: boolean }
): Promise<Artifact> {
  const target = await resolveRegisteredArtifactFile(workspaceDir, input.artifactId, input.filename, true)
  if (!target) throw new Error('Invalid artifact ID or filename')
  const bytes = input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8')
  const type = artifactTypeForPath(target.relativeName)
  const limit = type === ArtifactType.IMAGE ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
  if (bytes.length > limit) throw new Error(`Artifact file exceeds the ${limit}-byte limit`)

  const record = await updateArtifactRegistry(workspaceDir, async (registry) => {
    const artifact = registry.artifacts.find((candidate) => candidate.artifactId === input.artifactId && candidate.taskId === taskId)
    if (!artifact) throw new Error('Artifact not found for this task')
    await writeFile(target.absolutePath, bytes)
    if (!artifact.files.includes(target.relativeName)) artifact.files.push(target.relativeName)
    artifact.files.sort()
    const currentPriority = artifact.entryFile ? previewPriorityForPath(artifact.entryFile, artifact.type) : -1
    const candidateType = type || ArtifactType.FILE
    if (input.preview || !artifact.entryFile || previewPriorityForPath(target.relativeName, candidateType) > currentPriority) {
      artifact.entryFile = target.relativeName
      artifact.type = candidateType
    }
    artifact.updatedAt = Date.now()
    return artifact
  })
  return registeredArtifactToArtifact(record)
}

export async function editRegisteredTaskArtifactFile(
  workspaceDir: string,
  taskId: string,
  input: { artifactId: string; filename: string; textToReplace: string; replacement: string }
): Promise<Artifact> {
  const target = await resolveRegisteredArtifactFile(workspaceDir, input.artifactId, input.filename, false)
  if (!target) throw new Error('Invalid artifact ID or filename')
  const existing = await readFile(target.absolutePath, 'utf8')
  const first = existing.indexOf(input.textToReplace)
  if (first < 0) throw new Error('text_to_replace was not found')
  if (existing.indexOf(input.textToReplace, first + input.textToReplace.length) >= 0) {
    throw new Error('text_to_replace must match exactly one location')
  }
  const content = `${existing.slice(0, first)}${input.replacement}${existing.slice(first + input.textToReplace.length)}`
  return writeRegisteredTaskArtifactFile(workspaceDir, taskId, {
    artifactId: input.artifactId,
    filename: target.relativeName,
    content,
    preview: false
  })
}

export async function readRegisteredTaskArtifactFile(
  workspaceDir: string,
  taskId: string,
  artifactId: string,
  filename: string
): Promise<{ content: string; encoding: 'utf8' | 'base64'; mimeType?: string }> {
  const registry = await readArtifactRegistry(workspaceDir)
  if (!registry.artifacts.some((artifact) => artifact.artifactId === artifactId && artifact.taskId === taskId)) {
    throw new Error('Artifact not found for this task')
  }
  const target = await resolveRegisteredArtifactFile(workspaceDir, artifactId, filename, false)
  if (!target) throw new Error('Invalid artifact ID or filename')
  const type = artifactTypeForPath(target.relativeName)
  const bytes = await readFile(target.absolutePath)
  if (type === ArtifactType.IMAGE) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Artifact image exceeds the read limit')
    return { content: bytes.toString('base64'), encoding: 'base64', mimeType: IMAGE_MIME_TYPES[extname(target.relativeName).toLowerCase()] }
  }
  if (bytes.length > MAX_TEXT_BYTES) throw new Error('Artifact file exceeds the read limit')
  return { content: bytes.toString('utf8'), encoding: 'utf8', mimeType: TEXT_MIME_TYPES[extname(target.relativeName).toLowerCase()] || 'text/plain' }
}

function previewPriorityForPath(path: string, type: ArtifactType): number {
  const filename = path.split('/').pop()?.toLowerCase() || ''
  if (filename === 'index.html' || filename === 'index.htm') return 100
  if (filename === 'readme.md' || filename === 'readme.mdx') return 90
  if (type === ArtifactType.HTML) return 80
  if (type === ArtifactType.MARKDOWN) return 70
  if (type === ArtifactType.IMAGE) return 60
  return 10
}

/** Explicit registry is authoritative. The bounded directory scan remains as
 * an import/recovery path for artifacts created by older agents. */
export async function listTaskArtifactEntries(workspaceDir: string, taskId: string): Promise<ArtifactFileEntry[]> {
  const registered = await listRegisteredTaskArtifacts(workspaceDir, taskId)
  const registeredRoots = new Set(registered.map((artifact) => `${ARTIFACT_FILES_DIRECTORY}/${artifact.artifactId}/`))
  const explicitEntries = registered.map(registeredArtifactToEntry).filter((entry): entry is ArtifactFileEntry => entry !== null)
  const legacyEntries = (await scanTaskArtifacts(workspaceDir)).filter(
    (entry) => ![...registeredRoots].some((root) => entry.path.startsWith(root))
  )
  return [...explicitEntries, ...legacyEntries].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
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
    const relativePath = relative(rootPath, filePath).split(sep).join('/')
    const workpiece = artifactWorkpieceForPath(relativePath, type)
    return {
      path: relativePath,
      title: workpiece?.title || filePath.split(sep).pop() || artifactPath,
      type,
      updatedAt: fileStat.mtimeMs,
      size: fileStat.size,
      workpieceKey: workpiece?.key
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

  const artifacts = new Map<string, ArtifactFileEntry>()
  let discoveredFiles = 0

  const previewPriority = (entry: ArtifactFileEntry): number => previewPriorityForPath(entry.path, entry.type)

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || discoveredFiles >= MAX_SCAN_FILES) return

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (discoveredFiles >= MAX_SCAN_FILES) break
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

      const relativePath = relative(rootPath, absolutePath).split(sep).join('/')
      // A previewable source file is still code. Only root deliverables or files
      // below an explicit output boundary become logical artifact workpieces.
      const workpiece = artifactWorkpieceForPath(relativePath, type)
      if (!workpiece) continue

      try {
        const fileStat = await stat(absolutePath)
        if (!fileStat.isFile()) continue
        discoveredFiles++
        const candidate: ArtifactFileEntry = {
          path: relativePath,
          title: workpiece.title,
          type,
          updatedAt: fileStat.mtimeMs,
          size: fileStat.size,
          workpieceKey: workpiece.key
        }
        const previous = artifacts.get(workpiece.key)
        if (!previous || previewPriority(candidate) > previewPriority(previous)) {
          artifacts.set(workpiece.key, {
            ...candidate,
            updatedAt: Math.max(candidate.updatedAt, previous?.updatedAt || 0)
          })
        } else if (fileStat.mtimeMs > previous.updatedAt) {
          // Supporting-file edits reload the selected preview without replacing
          // its entry point or creating another top-level tab.
          artifacts.set(workpiece.key, { ...previous, updatedAt: fileStat.mtimeMs })
        }
      } catch {
        // A file can disappear while an agent is replacing it. Ignore it and
        // let the next hydration/refresh discover the replacement.
      }
    }
  }

  await visit(rootPath, 0)
  return [...artifacts.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
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
