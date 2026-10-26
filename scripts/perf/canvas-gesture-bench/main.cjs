/**
 * Canvas gesture benchmark — runs in a REAL Electron window (same window
 * options as src/main/index.ts on macOS: transparent background colour, and
 * `vibrancy: 'under-window'` when the desktop backdrop is enabled).
 *
 * Usage (build the renderer first so the app CSS exists):
 *   npx electron-vite build
 *   npx electron scripts/perf/canvas-gesture-bench/main.cjs \
 *     --css out/renderer/assets/index-*.css --panels 5,20,50 --backdrop 1,0 --runs 3
 *
 * Prints one JSON line per configuration with delivered frame stats for a
 * 3 s pinch-zoom and a 3 s pan gesture (rAF intervals: fps, p50/p95, number
 * of frames over 17.5 / 34 / 50 ms).
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}

const cssArg = arg('css')
if (!cssArg) {
  console.error('--css <path to compiled renderer css> is required')
  process.exit(2)
}
const cssPath = path.resolve(cssArg)
if (!fs.existsSync(cssPath)) {
  console.error(`css not found: ${cssPath}`)
  process.exit(2)
}
const panelCounts = String(arg('panels', '5,20,50')).split(',').map(Number)
const backdrops = String(arg('backdrop', '1,0')).split(',')
const runs = Number(arg('runs', '3'))
const label = arg('label', path.basename(cssPath))
const theme = arg('theme', 'dark')

async function runOne(panels, backdrop) {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    x: 40,
    y: 40,
    show: true,
    backgroundColor: isMac ? '#00000000' : '#1E2127',
    ...(isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window' } : {}),
    webPreferences: { backgroundThrottling: false },
  })
  // The app turns vibrancy off at runtime when the backdrop setting is off.
  if (isMac && backdrop !== '1') win.setVibrancy(null)
  const url = pathToFileURL(path.join(__dirname, 'page.html'))
  url.searchParams.set('css', pathToFileURL(cssPath).href)
  url.searchParams.set('panels', String(panels))
  url.searchParams.set('backdrop', backdrop)
  url.searchParams.set('theme', theme)
  await win.loadURL(url.href)
  win.focus()
  const result = await win.webContents.executeJavaScript('window.runBench()')
  win.destroy()
  return result
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function merge(results) {
  const out = {}
  for (const g of ['zoom', 'pan']) {
    out[g] = {}
    for (const k of Object.keys(results[0][g])) out[g][k] = median(results.map((r) => r[g][k]))
  }
  out.backdropFilterElements = results[0].backdropFilterElements
  return out
}

// Keep running between windows (Electron quits when the last window closes).
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  for (const backdrop of backdrops) {
    for (const panels of panelCounts) {
      const all = []
      for (let r = 0; r < runs; r++) all.push(await runOne(panels, backdrop))
      console.log(JSON.stringify({ label, backdrop: backdrop === '1', panels, ...merge(all) }))
    }
  }
  app.quit()
})
