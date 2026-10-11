import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderScadFile } from './scad-preview'

describe.skipIf(process.platform === 'win32')('SCAD render process', () => {
  let directory: string | null = null
  const previous = process.env.OPENSCAD_BINARY

  afterEach(async () => {
    if (previous === undefined) delete process.env.OPENSCAD_BINARY
    else process.env.OPENSCAD_BINARY = previous
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('runs OpenSCAD with the file and returns STL bytes', async () => {
    directory = await mkdtemp(join(tmpdir(), '20x-scad-render-'))
    const input = join(directory, 'case.scad')
    const binary = join(directory, 'openscad')
    await writeFile(input, 'cube(10);')
    await writeFile(binary, '#!/bin/sh\n[ "$1" = "-o" ] && [ "$3" = "' + input + '" ] || exit 1\nprintf "solid case\\nendsolid case\\n" > "$2"\n')
    await chmod(binary, 0o755)
    process.env.OPENSCAD_BINARY = binary

    expect(Buffer.from(await renderScadFile(input), 'base64').toString()).toBe('solid case\nendsolid case\n')
  })
})
