# Task Source Setup Guide

Task sources connect 20x to external systems like Linear, HubSpot, or Peakflo, allowing you to automatically import and sync tasks.

---

## Quick Start

1. **Choose a plugin** — Select Linear, HubSpot, or Peakflo
2. **Configure authentication** — Set up OAuth or API tokens
3. **Connect & authorize** — Complete the authentication flow
4. **Sync tasks** — Import tasks from the external system

---

## Linear Setup

Linear uses OAuth 2.0 for secure authentication.

### Prerequisites
- Linear account with API access
- Admin access to create OAuth applications

### Step-by-Step Instructions

**1. Create a Linear OAuth Application**
   - Go to [linear.app/settings/api/applications/new](https://linear.app/settings/api/applications/new)
   - Fill in the application details:
     - **Name**: `20x Desktop` (or any name you prefer)
     - **Redirect URI**: `nuanu://oauth/callback`
     - **Description**: Optional
   - Click **Create**

**2. Copy OAuth Credentials**
   - After creating, you'll see:
     - **Client ID** — A long alphanumeric string
     - **Client Secret** — Click "Show" to reveal
   - Keep this tab open, you'll need both values

**3. Configure in 20x**
   - In 20x, open **Settings → Integrations**
   - Click **Add Source**
   - Select **Linear** plugin
   - Enter a name (e.g., "Linear - My Team")
   - Paste **Client ID** from Linear
   - Paste **Client Secret** from Linear
   - Choose **Permissions**:
     - `read` — View issues only
     - `read,write` — View and update issues
     - `read,write,issues:create` — View, update, and create issues
     - `read,write,issues:create,comments:create` — Full access (recommended)

**4. Connect & Authorize**
   - Click **Connect to Linear**
   - A browser window will open
   - Log in to Linear if needed
   - Click **Authorize** to grant access
   - The window will close automatically

**5. Verify Connection**
   - Back in 20x, you should see **✓ Connected to Linear**
   - Click **Add** to save the task source
   - Click **Sync** to import tasks

### Troubleshooting
- **"OAuth failed"** — Double-check your Client ID and Secret
- **"Redirect URI mismatch"** — Ensure you used `nuanu://oauth/callback` exactly
- **"No tasks imported"** — Check your Linear filters (team, status, etc.)

---

## HubSpot Setup

HubSpot supports both OAuth 2.0 (recommended) and Private App tokens.

### Option A: OAuth 2.0 (Recommended)

**Prerequisites**
- HubSpot account with developer access
- Ability to create apps in your HubSpot account

**1. Create a HubSpot OAuth App**
   - Follow the [HubSpot Quickstart Guide](https://developers.hubspot.com/docs/getting-started/quickstart)
   - Key steps:
     - Go to HubSpot Developer Account → Apps → Create app
     - Set **Redirect URI** to: `http://localhost:3000/callback` (ports 3000-3010 supported)
     - Enable required scopes:
       - `tickets`
       - `crm.objects.contacts.read`
       - `crm.objects.owners.read`
       - `files`
       - `forms-uploaded-files`

**2. Copy OAuth Credentials**
   - Go to **Auth** tab in your HubSpot app
   - Copy:
     - **Client ID**
     - **Client Secret** (click "Show")

**3. Configure in 20x**
   - Settings → Integrations → Add Source
   - Select **HubSpot** plugin
   - Enter a name (e.g., "HubSpot - Support Tickets")
   - Choose **OAuth 2.0** authentication
   - Paste **Client ID**
   - Paste **Client Secret**

**4. Connect & Authorize**
   - Click **Connect to HubSpot**
   - Log in to HubSpot
   - Select your HubSpot account
   - Click **Grant access**
   - The OAuth flow will complete automatically

**5. Configure Filters (Optional)**
   - After connecting, you can filter tasks by:
     - **Pipeline** — Select a specific ticket pipeline
     - **Owner** — Show only tickets assigned to specific users
   - Click **↻ Refresh** to load current pipelines/owners

### Option B: Private App Token

**Prerequisites**
- HubSpot account admin access

**1. Create a Private App**
   - Go to **Settings → Integrations → Private Apps**
   - Click **Create private app**
   - Give it a name (e.g., "20x Integration")
   - Go to **Scopes** tab and enable:
     - `tickets`
     - `crm.objects.contacts.read`
     - `crm.objects.owners.read`
     - `files`
     - `forms-uploaded-files`
   - Click **Create app**

**2. Copy Access Token**
   - After creation, click **Show token**
   - Copy the access token (starts with `pat-...`)

**3. Configure in 20x**
   - Settings → Integrations → Add Source
   - Select **HubSpot** plugin
   - Choose **Private App Access Token** authentication
   - Paste your access token
   - Click **Add**

### Troubleshooting
- **"Invalid credentials"** — Verify token or OAuth credentials
- **"Missing scopes"** — Ensure all required scopes are enabled
- **"No tickets found"** — Check your pipeline/owner filters

---

## Peakflo Setup

Peakflo uses API key authentication.

### Prerequisites
- Peakflo account with API access
- Admin rights to generate API keys

**1. Generate Peakflo API Key**
   - Log in to Peakflo
   - Go to **Settings → API Keys** (or similar)
   - Click **Generate New Key**
   - Copy the API key (shown only once!)

**2. Configure in 20x**
   - Settings → Integrations → Add Source
   - Select **Peakflo** plugin
   - Enter a name (e.g., "Peakflo - Accounts Payable")
   - Paste **API Key**
   - Configure any filters (if available)

**3. Save & Sync**
   - Click **Add**
   - Click **Sync** to import tasks

### Troubleshooting
- **"Authentication failed"** — Regenerate your API key
- **"No tasks imported"** — Check task filters in Peakflo

---

## General Tips

### Security Best Practices
- ✅ **OAuth credentials are encrypted** — 20x uses Electron's `safeStorage` to encrypt all tokens
- ✅ **Tokens never leave your machine** — All data is stored locally in SQLite
- ⚠️ **Don't share API keys** — Treat them like passwords
- 🔄 **Rotate keys regularly** — Update credentials every 90 days

### Syncing & Updates
- **Manual sync** — Click the **↻ Sync** button to import new tasks
- **Auto-sync** — Coming soon (roadmap feature)
- **Two-way sync** — Status updates in 20x can be pushed back to the source system

### Managing Multiple Sources
- You can create multiple task sources for the same plugin
- Example: "Linear - Frontend Team" and "Linear - Backend Team"
- Each source maintains its own OAuth connection
- Filters help prevent duplicate imports

### Deleting Task Sources
- Deleting a source **keeps imported tasks** but removes the source link
- Tasks can no longer sync with the external system
- To reconnect, create a new source and re-sync

---

## Need Help?

- 📖 **Documentation**: [README.md](./README.md)
- 🐛 **Report Issues**: [GitHub Issues](https://github.com/peakflo/pf-desktop/issues)
- 💬 **Community**: [Discord](https://discord.gg/bPgkmycM)
