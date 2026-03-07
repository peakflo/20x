# Enterprise Tab in Settings — Specification (20x Desktop App)

## Overview

Add a new "Enterprise" tab to the 20x desktop app Settings panel that allows users to log in to the 20x Cloud platform (powered by pf-workflo's Supabase auth), select an organization/tenant, and store credentials locally for future API interactions with the pf-workflo backend.

---

## 1. Architecture Summary

```
20x Electron App                          pf-workflo (workflow-builder)
=================                         ============================

Renderer (React)                          workflow-api (Fastify)
  EnterpriseSettings.tsx                    POST /api/20x/auth/login
  enterprise-store.ts                       GET  /api/20x/auth/companies
                                            POST /api/20x/auth/select-tenant
        |                                   GET  /api/20x/auth/token
        v                                         |
Preload (IPC bridge)                              v
  enterprise:* channels                    Supabase Auth (existing)
        |                                  PostgreSQL (users_ext, user_companies,
        v                                             companies, roles)
Main Process
  enterprise-auth.ts
    - Supabase client (anon key)
    - Token storage (settings DB)
    - HTTP calls to workflow-api
```

## 2. UI Changes (Renderer)

### 2.1 New Settings Tab

Add `ENTERPRISE = 'enterprise'` to the `SettingsTab` enum in `src/renderer/src/types/index.ts`:

```typescript
export enum SettingsTab {
  GENERAL = 'general',
  AGENTS = 'agents',
  TOOLS_MCP = 'tools-mcp',
  SECRETS = 'secrets',
  INTEGRATIONS = 'integrations',
  ENTERPRISE = 'enterprise',   // <-- new
  ADVANCED = 'advanced'
}
```

Update `SETTINGS_TABS` array, `SettingsWorkspace.tsx` tab list, and icon map (use `Building2` from lucide-react).

### 2.2 EnterpriseSettings Component

File: `src/renderer/src/components/settings/tabs/EnterpriseSettings.tsx`

**States:**

| State | Description |
|-------|-------------|
| `logged-out` | Show email + password form with "Sign in to 20x Cloud" button |
| `selecting-tenant` | Show list of orgs/tenants the user belongs to, user picks one |
| `logged-in` | Show connected status: user email, current org name, "Switch org" and "Sign out" buttons |
| `error` | Inline error banner (wrong password, network error, etc.) |

**Logged-out view:**
- SettingsSection title: "20x Cloud"
- Description: "Connect to your organization's 20x Cloud to access enterprise features"
- Email input field
- Password input field
- "Sign in" button (primary)
- Loading spinner during auth

**Selecting-tenant view:**
- List of companies returned from API, each as a selectable card showing company name
- "Select" button per company
- "Cancel" link to go back to logged-out

**Logged-in view:**
- SettingsSection showing:
  - Connected status badge (green dot + "Connected")
  - User email (read-only)
  - Current organization name (read-only)
  - "Switch organization" button (secondary) -> goes to selecting-tenant
  - "Sign out" button (destructive variant)
- Future: additional sections will appear here for enterprise API features

### 2.3 Enterprise Store

File: `src/renderer/src/stores/enterprise-store.ts`

```typescript
interface EnterpriseState {
  // Auth state
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  // User info (persisted via main process settings)
  userEmail: string | null
  userId: string | null
  currentTenant: { id: string; name: string } | null
  availableTenants: { id: string; name: string }[] | null

  // Actions
  login: (email: string, password: string) => Promise<void>
  selectTenant: (tenantId: string) => Promise<void>
  logout: () => Promise<void>
  loadSession: () => Promise<void>  // restore from persisted state on app start
  refreshToken: () => Promise<void>
}
```

## 3. IPC Layer

### 3.1 Preload Bridge

Add to `src/preload/index.ts`:

```typescript
enterprise: {
  login: (email: string, password: string): Promise<{
    userId: string
    email: string
    companies: { id: string; name: string }[]
  }> => ipcRenderer.invoke('enterprise:login', email, password),

  selectTenant: (tenantId: string): Promise<{
    token: string
    tenant: { id: string; name: string }
  }> => ipcRenderer.invoke('enterprise:selectTenant', tenantId),

  logout: (): Promise<void> =>
    ipcRenderer.invoke('enterprise:logout'),

  getSession: (): Promise<{
    isAuthenticated: boolean
    userEmail: string | null
    userId: string | null
    currentTenant: { id: string; name: string } | null
  }> => ipcRenderer.invoke('enterprise:getSession'),

  refreshToken: (): Promise<{ token: string }> =>
    ipcRenderer.invoke('enterprise:refreshToken'),

  apiRequest: (method: string, path: string, body?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('enterprise:apiRequest', method, path, body)
}
```

### 3.2 IPC Client (Renderer)

Add to `src/renderer/src/lib/ipc-client.ts`:

```typescript
export const enterpriseApi = {
  login: (email: string, password: string) =>
    window.electronAPI.enterprise.login(email, password),
  selectTenant: (tenantId: string) =>
    window.electronAPI.enterprise.selectTenant(tenantId),
  logout: () =>
    window.electronAPI.enterprise.logout(),
  getSession: () =>
    window.electronAPI.enterprise.getSession(),
  refreshToken: () =>
    window.electronAPI.enterprise.refreshToken(),
  apiRequest: (method: string, path: string, body?: unknown) =>
    window.electronAPI.enterprise.apiRequest(method, path, body)
}
```

## 4. Main Process

### 4.1 Enterprise Auth Module

File: `src/main/enterprise-auth.ts`

Responsibilities:
1. **Supabase sign-in**: Use `@supabase/supabase-js` client with the pf-workflo Supabase project's public URL and anon key (configured via env vars or hardcoded for the specific project).
2. **Fetch companies**: After Supabase auth succeeds, call `GET {WORKFLO_API_URL}/api/user/companies?userId={supabaseUserId}` to get the user's available tenants.
3. **Select tenant & get JWT**: Call `POST {WORKFLO_API_URL}/api/20x/auth/select-tenant` with the Supabase access token and chosen tenantId. Server returns a pf-workflo JWT.
4. **Token storage**: Persist in the existing settings SQLite DB:
   - `enterprise_supabase_access_token` (encrypted)
   - `enterprise_supabase_refresh_token` (encrypted)
   - `enterprise_jwt` (the pf-workflo JWT for API calls)
   - `enterprise_user_email`
   - `enterprise_user_id`
   - `enterprise_tenant_id`
   - `enterprise_tenant_name`
5. **Token refresh**: On app start and periodically, refresh the Supabase session and re-obtain the pf-workflo JWT if expired.
6. **API proxy**: The `enterprise:apiRequest` handler attaches the stored JWT as `Authorization: Bearer {jwt}` and forwards requests to the workflow-api.

```typescript
// Pseudocode structure
class EnterpriseAuth {
  private supabase: SupabaseClient
  private workfloApiUrl: string
  private jwt: string | null = null

  async login(email: string, password: string): Promise<LoginResult>
  async selectTenant(tenantId: string): Promise<SelectTenantResult>
  async logout(): Promise<void>
  async getSession(): Promise<SessionInfo>
  async refreshToken(): Promise<string>
  async apiRequest(method: string, path: string, body?: unknown): Promise<unknown>
}
```

### 4.2 IPC Handler Registration

Add to `src/main/ipc-handlers.ts`:

```typescript
// Enterprise auth handlers
ipcMain.handle('enterprise:login', async (_, email, password) => {
  return enterpriseAuth.login(email, password)
})

ipcMain.handle('enterprise:selectTenant', async (_, tenantId) => {
  return enterpriseAuth.selectTenant(tenantId)
})

ipcMain.handle('enterprise:logout', async () => {
  return enterpriseAuth.logout()
})

ipcMain.handle('enterprise:getSession', async () => {
  return enterpriseAuth.getSession()
})

ipcMain.handle('enterprise:refreshToken', async () => {
  return enterpriseAuth.refreshToken()
})

ipcMain.handle('enterprise:apiRequest', async (_, method, path, body) => {
  return enterpriseAuth.apiRequest(method, path, body)
})
```

## 5. Configuration

New environment variables / settings for the 20x app:

| Variable | Description | Example |
|----------|-------------|---------|
| `ENTERPRISE_SUPABASE_URL` | Supabase project URL for pf-workflo | `https://xxx.supabase.co` |
| `ENTERPRISE_SUPABASE_ANON_KEY` | Supabase anon/public key | `eyJ...` |
| `ENTERPRISE_API_URL` | pf-workflo workflow-api base URL | `https://api.workflo.peakflo.co` |

These can be baked into the Electron build or read from env. They are NOT user-configurable — they point to the specific pf-workflo deployment.

## 6. Auth Flow (Step by Step)

```
1. User opens Settings > Enterprise tab
2. User enters email + password, clicks "Sign in"
3. Renderer -> IPC -> Main: enterprise:login(email, password)
4. Main: supabase.auth.signInWithPassword({ email, password })
5. Main: On success, gets Supabase session (access_token, refresh_token, user.id)
6. Main: GET {WORKFLO_API_URL}/api/user/companies?userId={user.id}
7. Main: Returns { userId, email, companies[] } to renderer
8. Renderer shows tenant selection UI
9. User picks a tenant, clicks "Select"
10. Renderer -> IPC -> Main: enterprise:selectTenant(tenantId)
11. Main: POST {WORKFLO_API_URL}/api/20x/auth/select-tenant
        Body: { userId, tenantId }
        Headers: Authorization: Bearer {supabase_access_token}
12. Server: Validates Supabase token, verifies user-tenant relationship,
           creates pf-workflo JWT with { tenantId, userId }
13. Main: Stores all tokens + metadata in settings DB
14. Main: Returns { token, tenant: { id, name } } to renderer
15. Renderer updates store -> shows "Connected" state
```

## 7. Token Lifecycle

- **Supabase session**: 1-hour access token, long-lived refresh token. Main process uses `supabase.auth.refreshSession()` proactively.
- **pf-workflo JWT**: 1-hour lifetime (matching `createToken` defaults in core/jwt.ts). Refreshed by calling the select-tenant endpoint again with a valid Supabase session.
- **On app start**: Main process calls `enterprise:getSession`. If tokens exist, validate/refresh them silently. If refresh fails, mark as logged out.
- **API requests**: Before each `enterprise:apiRequest`, check JWT expiry. If < 5 min remaining, refresh first. This mirrors the pattern in `workflow-builder/packages/ui/app/lib/auth.ts`.

## 8. Future Extensibility

The `enterprise:apiRequest` IPC channel is a generic proxy for any authenticated call to the workflow-api. Future features can use it without adding new IPC channels:

```typescript
// Example: fetch workflows for the tenant
const workflows = await enterpriseApi.apiRequest('GET', '/api/workflows')

// Example: trigger a workflow
await enterpriseApi.apiRequest('POST', `/api/workflows/${id}/trigger`, { input })
```

The Enterprise tab UI can be extended with additional SettingsSections for each feature (e.g., "Workflows", "Team Members", "API Keys") as they become available.

## 9. Files to Create / Modify

### 20x (peakflo/20x)

| Action | File |
|--------|------|
| Create | `src/renderer/src/components/settings/tabs/EnterpriseSettings.tsx` |
| Create | `src/renderer/src/stores/enterprise-store.ts` |
| Create | `src/main/enterprise-auth.ts` |
| Modify | `src/renderer/src/types/index.ts` — add `ENTERPRISE` to `SettingsTab` enum |
| Modify | `src/renderer/src/components/settings/SettingsWorkspace.tsx` — add Enterprise tab |
| Modify | `src/preload/index.ts` — add `enterprise:*` IPC bridge |
| Modify | `src/renderer/src/lib/ipc-client.ts` — add `enterpriseApi` |
| Modify | `src/main/ipc-handlers.ts` — register enterprise handlers |
| Modify | `package.json` — add `@supabase/supabase-js` dependency |

### New dependency

```
pnpm add @supabase/supabase-js
```

## 10. Security Considerations

- Supabase access/refresh tokens stored in the local SQLite settings DB should be encrypted (use the existing secret encryption utils if available, or electron's `safeStorage`).
- The pf-workflo JWT is scoped to a specific tenant — switching tenants requires obtaining a new JWT.
- The `enterprise:apiRequest` proxy in main process ensures tokens never leak to the renderer directly; the renderer only sees response data.
- Password is transmitted over IPC to main process only for the initial sign-in; it is never stored.
