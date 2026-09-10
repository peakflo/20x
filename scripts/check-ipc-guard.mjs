// Run with `node scripts/check-ipc-guard.mjs` on a desktop with a display.
// Uses the installed Electron and the production guard in a separate app.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = mkdtempSync(join(tmpdir(), '20x-ipc-check-'))
try {
  for (const name of ['ipc-message-size', 'guarded-ipc-send']) {
    const source = readFileSync(join(root, 'src/main', `${name}.ts`), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    writeFileSync(join(temporary, `${name}.js`), outputText)
  }
  writeFileSync(join(temporary, 'preload.js'), `
    const { ipcRenderer } = require('electron')
    const parts = []
    const revisions = []
    const seen = []
    ipcRenderer.on('probe:normal', (_, data) => seen.push(data.value))
    ipcRenderer.on('probe:blocked', () => seen.push('UNSAFE'))
    ipcRenderer.on('transcript:changed', (_, data) => {
      revisions.push(data.maxRev)
      parts.push(...data.parts.map(p => ({ id: p.partId, length: p.content.length, first: p.content[0] })))
    })
    ipcRenderer.on('probe:done', () => ipcRenderer.send('probe:result', { parts, revisions, seen }))
  `)
  writeFileSync(join(temporary, 'main.cjs'), `
    const assert = require('node:assert/strict')
    const { join } = require('node:path')
    const { app, BrowserWindow, dialog, ipcMain } = require('electron')
    const { guardedIpcSend } = require('./guarded-ipc-send')
    app.setPath('userData', join(__dirname, 'user-data'))
    app.disableHardwareAcceleration()
    let notices = 0
    dialog.showMessageBox = async () => { notices++; return { response: 0 } }
    const timeout = setTimeout(() => { console.error('IPC check timed out'); app.exit(1) }, 20000)
    app.whenReady().then(async () => {
      app.dock?.hide()
      const window = new BrowserWindow({ show: false, webPreferences: {
        preload: join(__dirname, 'preload.js'), sandbox: false
      } })
      ipcMain.once('probe:result', (_, result) => {
        try {
          assert.deepEqual(result.seen, ['before', 'after'])
          assert.equal(result.parts.length, 12)
          for (let i = 0; i < 12; i++) {
            assert.deepEqual(result.parts[i], { id: String(i), length: 400000, first: 'あ' })
          }
          assert.ok(result.revisions.length > 1)
          assert.ok(result.revisions.slice(0, -1).every(rev => rev === 0))
          assert.equal(result.revisions.at(-1), 12)
          assert.equal(notices, 1)
          console.log('PASS: normal delivery, excessive string blocked, complete ordered transcript chunks, renderer alive')
          clearTimeout(timeout)
          app.exit(0)
        } catch (error) { console.error(error); app.exit(1) }
      })
      await window.loadURL('data:text/html,<title>IPC guard check</title>')
      const target = window.webContents
      guardedIpcSend(target, 'probe:normal', { value: 'before' })
      assert.equal(guardedIpcSend(target, 'probe:blocked', { content: 'x'.repeat(256 * 1024 * 1024) }), false)
      const parts = Array.from({ length: 12 }, (_, i) => ({
        partId: String(i), rev: i + 1, content: 'あ'.repeat(400000)
      }))
      assert.equal(guardedIpcSend(target, 'transcript:changed', { taskId: 'test', parts, maxRev: 12 }), true)
      guardedIpcSend(target, 'probe:normal', { value: 'after' })
      guardedIpcSend(target, 'probe:done')
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [join(temporary, 'main.cjs')], {
    env, encoding: 'utf8', timeout: 30000
  })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, result.error?.message || 'Electron IPC check failed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
