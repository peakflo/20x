import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)

const compositionIds = ['SidebarSubtasks', 'DetailViewSubtasks', 'SubtaskNavigation']
const outDir = path.resolve(import.meta.dirname, 'out')

fs.mkdirSync(outDir, { recursive: true })

console.log('Bundling...')
const bundleLocation = await bundle({
  entryPoint: path.resolve(import.meta.dirname, 'index.ts'),
  webpackOverride: (config) => config,
})

for (const id of compositionIds) {
  console.log(`Rendering ${id}...`)
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id,
  })

  const outputFile = path.join(outDir, `${id}.png`)
  await renderStill({
    composition,
    serveUrl: bundleLocation,
    output: outputFile,
  })
  console.log(`  -> ${outputFile}`)
}

console.log('Done!')
