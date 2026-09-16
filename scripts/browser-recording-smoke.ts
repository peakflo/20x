/** Local Electron smoke test. No production page or user profile is used. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PanelBrowserBroker } from '../src/main/panel-browser-broker'

const profile = mkdtempSync(join(tmpdir(), '20x-recording-smoke-'))
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const broker = new PanelBrowserBroker()
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(request.url?.startsWith('/next')
    ? '<!doctype html><title>Next page</title><label for="last">Reference</label><input id="last"><button id="next">Finish</button>'
    : `<!doctype html><title>Recording fixture</title>
      <label for="invoice">Invoice number</label><input id="invoice" name="invoice_number">
      <label for="password">Password</label><input id="password" type="password" value="smoke-secret-do-not-save">
      <button id="manual" onclick="document.querySelector('#result').textContent='Manual complete'">Manual action</button>
      <button id="agent" onclick="document.querySelector('#result').textContent='Agent complete'">Agent action</button>
      <p id="result">Ready</p>`)
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean, reason: string) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(reason)
    await delay(25)
  }
}

let window: BrowserWindow | undefined
async function run() {
  await app.whenReady()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  window = new BrowserWindow({ show: true, width: 800, height: 400, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const wc = window.webContents
  await wc.loadURL(base)
  window.focus()
  wc.focus()
  broker.registerPanel('fixture-panel', wc.id, ['task-a', 'task-b'])
  const started = await broker.startRecording('fixture-panel', 'Local fixture')
  assert('ok' in started, JSON.stringify(started))
  const id = started.recording.id

  // sendInputEvent uses Electron's actual input path, rather than dispatchEvent.
  const point = await wc.executeJavaScript(`(() => { const r = document.querySelector('#manual').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`)
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await waitFor(() => broker.recordings.steps('task-a', id).steps.some((step) => step.source === 'human' && step.action === 'click'), 'Manual click was not recorded')

  const typed = await broker.type('task-a', '#invoice', 'INV-42', false, 'fixture-panel')
  assert(!typed.error, JSON.stringify(typed))
  const clicked = await broker.click('task-a', '#agent', 'fixture-panel')
  assert(!clicked.error, JSON.stringify(clicked))
  await wc.loadURL(`${base}/next?token=smoke-secret-do-not-save`)
  await delay(150)
  await wc.executeJavaScript("document.querySelector('#last').focus()")
  await wc.insertText('LAST-INPUT-42')
  // Stop immediately, before the coalescing timer fires or the field loses focus.
  const stopped = await broker.stopRecording('fixture-panel')
  assert('ok' in stopped, JSON.stringify(stopped))
  assert.deepEqual(stopped.recording.taskIds.sort(), ['task-a', 'task-b'])
  const rows = broker.recordings.steps('task-a', id, 0, 100).steps
  assert(rows.some((step) => step.source === 'agent'), 'Agent action was not recorded')
  assert(rows.some((step) => step.source === 'agent' && step.target?.includes('Invoice number')), 'Agent action target lost its field label')
  assert(rows.some((step) => step.source === 'human' && step.action === 'input'), 'Stop lost a pending field edit')
  assert(rows.some((step) => step.action === 'document-ready'), 'Navigation was not recorded')
  const recorded = rows.find((step) => step.snapshotId)
  assert(recorded?.snapshotId)
  broker.unregisterPanel('fixture-panel')
  window.close()
  window = undefined
  assert(broker.recordings.snapshot('task-b', id, recorded.snapshotId).elements.length > 0)
  const reloaded = new PanelBrowserBroker()
  assert.equal(reloaded.recordings.get('task-a', id).id, id)
  assert.throws(() => reloaded.recordings.get('unrelated-task', id))
  assert.throws(() => reloaded.recordings.snapshot('task-a', id, '../manifest'))
  const folder = join(profile, 'browser-recordings', id)
  for (const file of readdirSync(folder)) {
    assert(!readFileSync(join(folder, file), 'utf8').includes('smoke-secret-do-not-save'), `Secret found in ${file}`)
  }
  assert(readdirSync(folder).some((file) => readFileSync(join(folder, file), 'utf8').includes('LAST-INPUT-42')), 'Final field value was not saved')
  console.log(JSON.stringify({ result: 'PASS', steps: rows.length, checks: ['manual input', 'agent actions', 'navigation', 'saved snapshots', 'restart', 'task access', 'secret exclusion'] }))
}

run().then(() => finish(0), (error) => { console.error(error); finish(1) })
function finish(code: number) {
  broker.stopAll()
  window?.close()
  server.closeAllConnections()
  server.close()
  rmSync(profile, { recursive: true, force: true })
  process.exitCode = code
  // Let Electron stop its native event loop. process.exit() can leave the macOS
  // Electron host alive after Node has completed its shutdown work.
  setTimeout(() => {
    const reallyExit = (process as NodeJS.Process & { reallyExit?: (exitCode: number) => never }).reallyExit
    if (reallyExit) reallyExit(code)
    process.exit(code)
  }, 1000)
  app.quit()
}
