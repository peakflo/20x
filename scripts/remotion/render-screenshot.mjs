#!/usr/bin/env node
import { bundle } from '@remotion/bundler'
import { renderStill } from '@remotion/renderer'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  console.log('Bundling Remotion project...')
  const bundled = await bundle({
    entryPoint: path.join(__dirname, 'index.ts'),
    webpackOverride: (config) => config,
  })

  const outputPath = path.join(__dirname, '..', '..', 'docs', 'data-file-preview.png')

  console.log('Rendering screenshot...')
  await renderStill({
    composition: {
      id: 'DataFilePreview',
      durationInFrames: 1,
      fps: 1,
      width: 1200,
      height: 700,
      defaultProps: {},
      defaultCodec: null,
    },
    serveUrl: bundled,
    output: outputPath,
    frame: 0,
  })

  console.log(`Screenshot saved to: ${outputPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
