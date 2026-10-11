import { execFile } from 'child_process'
import { access, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, extname, join } from 'path'
import { promisify } from 'util'
import { listTaskArtifactEntries, resolveTaskArtifactFilePath } from './artifacts'

const execFileAsync = promisify(execFile)
const MAX_STL_BYTES = 25 * 1024 * 1024

async function openScadBinary(): Promise<string> {
  if (process.env.OPENSCAD_BINARY) return process.env.OPENSCAD_BINARY
  const candidates = process.platform === 'darwin'
    ? ['/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD', join(homedir(), 'Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD'), '/opt/homebrew/bin/openscad', '/usr/local/bin/openscad']
    : process.platform === 'win32'
      ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSCAD', 'openscad.exe'), join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenSCAD', 'openscad.exe')]
      : ['/usr/bin/openscad', '/usr/local/bin/openscad']
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* Try the next location. */ }
  }
  return process.platform === 'win32' ? 'openscad.exe' : 'openscad'
}

/** Render a visible task SCAD file with the locally installed OpenSCAD app. */
export async function renderScadFile(input: string): Promise<string> {
  if (extname(input).toLowerCase() !== '.scad') throw new Error('Only SCAD files can be rendered here')
  const temporaryDir = await mkdtemp(join(tmpdir(), '20x-scad-'))
  const output = join(temporaryDir, 'preview.stl')
  try {
    try {
      await execFileAsync(await openScadBinary(), ['-o', output, input], {
        cwd: dirname(input),
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true
      })
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
      if (failure.code === 'ENOENT') throw new Error('Install OpenSCAD to show a 3D preview.')
      if (failure.killed) throw new Error('OpenSCAD took too long to render this model.')
      throw new Error((failure.stderr || failure.message).trim().slice(0, 2000))
    }
    if ((await stat(output)).size > MAX_STL_BYTES) throw new Error('The 3D preview is too large to show.')
    const stl = await readFile(output)
    return stl.toString('base64')
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

export async function renderTaskScadArtifact(workspaceDir: string, taskId: string, artifactPath: string): Promise<string> {
  if (extname(artifactPath).toLowerCase() !== '.scad') throw new Error('Only SCAD files can be rendered here')
  const entries = await listTaskArtifactEntries(workspaceDir, taskId)
  if (!entries.some((entry) => entry.path === artifactPath || entry.files?.includes(artifactPath))) throw new Error('SCAD artifact not found')
  const input = await resolveTaskArtifactFilePath(workspaceDir, artifactPath)
  if (!input) throw new Error('SCAD artifact not found')
  return renderScadFile(input)
}
