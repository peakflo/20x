import { execSync } from 'child_process'

const WIN_ORPHAN_MCP_PS_COMMAND =
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*task-management-mcp*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'

/**
 * Shell command used to kill orphaned MCP processes. Exported for unit tests.
 */
export function getOrphanMcpKillCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `powershell.exe -NoProfile -Command "${WIN_ORPHAN_MCP_PS_COMMAND}"`
  }
  return 'pkill -f "task-management-mcp\\.js"'
}

/**
 * Kill orphaned task-management-mcp Node processes left behind when the app exits.
 * On Windows, match by command line (node.exe processes have no useful window title).
 */
export function killOrphanedMcpProcesses(platform: NodeJS.Platform = process.platform): void {
  try {
    execSync(getOrphanMcpKillCommand(platform), { stdio: 'ignore', timeout: 10_000 })
  } catch {
    // Non-zero exit or timeout when no processes matched — expected on shutdown
  }
}
