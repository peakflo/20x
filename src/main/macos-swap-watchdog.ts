import { dialog, utilityProcess } from 'electron'
import { join } from 'path'
import type { SwapWatchdogMessage } from './macos-swap-recovery'

export function swapWatchdogScriptPath(directory = __dirname): string {
  // The entry is explicitly unpacked by electron-builder. Use that real file
  // rather than depending on archive support in the utility process loader.
  return join(directory, 'macos-swap-watchdog-worker.js').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

/** Uses Electron's utility process, including builds with RunAsNode disabled. */
export function startMacosSwapWatchdog(): () => void {
  if (process.platform !== 'darwin') return () => {}
  try {
    const child = utilityProcess.fork(swapWatchdogScriptPath(), [], {
      serviceName: '20x disk recovery',
      stdio: 'ignore'
    })
    let stopped = false
    let warningOpen = false
    child.on('message', (message: SwapWatchdogMessage) => {
      if (stopped) return
      if (message.type === 'ping') {
        try {
          child.postMessage({ type: 'pong' })
        } catch (error) {
          console.warn('[SwapWatchdog] Heartbeat failed:', error)
        }
      }
      if (message.type === 'low-disk' && !warningOpen) {
        warningOpen = true
        void dialog.showMessageBox({
          type: 'warning',
          title: 'Startup disk nearly full',
          message: 'Free space on your startup disk to keep 20x running.',
          detail: 'Less than 2 GB is available. macOS needs disk space for swap and can pause 20x when it runs out. Free at least 10 GB.',
          buttons: ['OK']
        }).catch((error) => console.warn('[SwapWatchdog] Warning failed:', error))
          .finally(() => { warningOpen = false })
      }
      if (message.type === 'resumed') {
        console.warn('[SwapWatchdog] Continued main after swap exhaustion; free bytes:', message.freeBytes)
      }
    })
    child.on('exit', (code) => {
      if (!stopped) console.warn('[SwapWatchdog] Helper exited:', code)
    })
    child.on('error', (type, location) => {
      console.warn('[SwapWatchdog] Helper failed:', type, location)
    })
    return () => {
      if (stopped) return
      stopped = true
      child.kill()
    }
  } catch (error) {
    console.warn('[SwapWatchdog] Could not start:', error)
    return () => {}
  }
}
