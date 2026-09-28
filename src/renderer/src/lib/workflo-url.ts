import { enterpriseApi } from './ipc-client'

/**
 * Derive the Workflo (workflow-builder) frontend URL from the API URL.
 * Mirrors the logic in main/ipc-handlers.ts.
 *
 * Examples:
 * - http://localhost:2000        → http://localhost:4000
 * - https://api.peakflo.ai       → https://app.peakflo.ai
 * - https://stage-api.peakflo.ai → https://stage-app.peakflo.ai
 */
export async function getWorkfloFrontendUrl(): Promise<string> {
  try {
    const apiUrl = await enterpriseApi.getApiUrl()
    const parsed = new URL(apiUrl)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.port = '4000'
      return parsed.origin
    }
    // Production: api.X.ai → app.X.ai  or  stage-api.X.ai → stage-app.X.ai
    parsed.hostname = parsed.hostname.replace('-api.', '-app.').replace(/^api\./, 'app.')
    return parsed.origin
  } catch {
    return 'https://app.peakflo.ai'
  }
}
