/**
 * Health checking utilities for coding agent backends
 */

export interface HealthStatus {
  available: boolean
  reason?: string
}

/**
 * Check if OpenCode backend is healthy and usable
 */
export async function checkOpencodeHealth(): Promise<HealthStatus> {
  try {
    // 1. Check if SDK can be imported
    await import('@opencode-ai/sdk')

    // 2. Check if server is accessible (try both localhost and 127.0.0.1)
    const urls = ['http://localhost:4096', 'http://127.0.0.1:4096']

    for (const url of urls) {
      try {
        const response = await fetch(`${url}/global/health`, {
          signal: AbortSignal.timeout(2000)
        })

        if (response.ok) {
          return { available: true }
        }
      } catch {
        // Try next URL
      }
    }

    return { available: false, reason: 'Server not responding' }
  } catch (error) {
    return { available: false, reason: 'SDK not installed' }
  }
}

/**
 * Check if Claude Code backend is healthy and usable
 */
export async function checkClaudeCodeHealth(): Promise<HealthStatus> {
  try {
    // 1. Check if SDK can be imported
    await import('@anthropic-ai/claude-agent-sdk')

    // 2. Check if Claude CLI is installed and authenticated
    try {
      const { execSync } = await import('child_process')
      execSync('which claude', { stdio: 'ignore' })
    } catch {
      return {
        available: false,
        reason: 'Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code'
      }
    }

    // Claude Code uses CLI authentication, no API key needed
    return { available: true }
  } catch (error) {
    return { available: false, reason: 'SDK not installed' }
  }
}

/**
 * Check if GitHub CLI is installed and authenticated
 */
export async function checkGhCli(): Promise<{ installed: boolean; authenticated: boolean }> {
  try {
    const { execSync } = await import('child_process')

    // Check if gh is installed
    try {
      execSync('gh --version', { stdio: 'ignore' })
    } catch {
      return { installed: false, authenticated: false }
    }

    // Check if authenticated
    try {
      execSync('gh auth status', { stdio: 'ignore' })
      return { installed: true, authenticated: true }
    } catch {
      return { installed: true, authenticated: false }
    }
  } catch {
    return { installed: false, authenticated: false }
  }
}
