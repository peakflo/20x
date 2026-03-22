#!/usr/bin/env node
import { bundle } from '@remotion/bundler'
import { renderStill } from '@remotion/renderer'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const compositions = [
  { id: 'DataFilePreview', width: 1200, height: 700, output: 'data-file-preview.png' },
  { id: 'MarimoEmbed', width: 1200, height: 900, output: 'marimo-embed.png' },
]

async function main() {
  const target = process.argv[2] // optional: render only one

  console.log('Bundling Remotion project...')
  const bundled = await bundle({
    entryPoint: path.join(__dirname, 'index.ts'),
    webpackOverride: (config) => config,
  })

  for (const comp of compositions) {
    if (target && comp.id !== target) continue

    const outputPath = path.join(__dirname, '..', '..', 'docs', comp.output)

    console.log(`Rendering ${comp.id}...`)
    await renderStill({
      composition: {
        id: comp.id,
        durationInFrames: 1,
        fps: 1,
        width: comp.width,
        height: comp.height,
        defaultProps: {},
        defaultCodec: null,
      },
      serveUrl: bundled,
      output: outputPath,
      frame: 0,
    })

    console.log(`  → ${outputPath}`)
  }

  console.log('Done!')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
