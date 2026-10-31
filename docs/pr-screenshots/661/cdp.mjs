#!/usr/bin/env node
// Small CDP client for the real Electron renderer. No browser page is mocked.
import fs from 'node:fs/promises'
import WebSocket from 'ws'

const [action, ...args] = process.argv.slice(2)
const port = Number(process.env.CDP_PORT || 9331)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find((entry) => process.env.CDP_TARGET === 'iframe'
  ? entry.type === 'iframe' && entry.url === 'about:srcdoc'
  : entry.type === 'page' && entry.title === '20x')
if (!target) throw new Error('20x renderer target not found')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
let nextId = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (!msg.id) return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
})
function call(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
try {
  if (action === 'eval') console.log(JSON.stringify(await evaluate(args.join(' ')), null, 2))
  else if (action === 'shot') {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.writeFile(args[0], Buffer.from(result.data, 'base64'))
    console.log(args[0])
  } else if (action === 'click') {
    const x = Number(args[0]), y = Number(args[1])
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } else if (action === 'reload') {
    await call('Page.reload', { ignoreCache: true })
  } else throw new Error('Usage: cdp.mjs eval EXPR | shot PATH | click X Y | reload')
} finally {
  ws.close()
}
