/**
 * Converts resources/icon.png to resources/icon.ico for Windows builds.
 */
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const inputPath = join(__dirname, '..', 'resources', 'icon.png')
const outputPath = join(__dirname, '..', 'resources', 'icon.ico')

const buf = await pngToIco(inputPath)
writeFileSync(outputPath, buf)
console.log(`Created ${outputPath}`)
