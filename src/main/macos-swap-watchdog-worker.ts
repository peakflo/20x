import { MacosSwapRecovery, SWAP_CHECK_INTERVAL_MS, swapRecoveryDependencies } from './macos-swap-recovery'

// A separate PROCESS is essential: main's timers and worker threads cannot
// recover main when macOS suspends its entire task due to swap exhaustion.
const parentPid = process.ppid
const port = process.parentPort
if (process.platform === 'darwin' && port) {
  const recovery = new MacosSwapRecovery(swapRecoveryDependencies(parentPid, (message) => port.postMessage(message)))
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      recovery.stop()
      clearInterval(timer)
      process.exit(0)
    }
    void recovery.check()
  }, SWAP_CHECK_INTERVAL_MS)
  port.on('message', ({ data }) => {
    if (data?.type === 'pong') recovery.pong()
    if (data?.type === 'stop') {
      recovery.stop()
      clearInterval(timer)
      process.exit(0)
    }
  })
  void recovery.check()
}
