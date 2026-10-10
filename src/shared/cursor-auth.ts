/**
 * Renderer-facing types for the Cursor SDK's subscription (browser-login)
 * sign-in status, shown on the Settings → Agents "Cursor" card.
 *
 * API-key auth status is per-agent config (see AgentForm's existing Cursor
 * API key field) and isn't represented here — this is only the shared
 * browser-login credential this adapter manages end to end.
 */

export interface CursorAuthStatus {
  authenticated: boolean
  email?: string
  reason?: string
}

export interface CursorLoginUrlResult {
  url: string
}

export type CursorLoginCompleteEvent = { success: true; email?: string } | { success: false; error: string }
