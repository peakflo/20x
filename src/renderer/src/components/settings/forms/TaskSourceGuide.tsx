import ReactMarkdown from 'react-markdown'

const TASK_SOURCE_GUIDE = `
# Setup Guide

Task sources connect 20x to external systems to import and sync tasks automatically.

---

## Linear Setup

**1. Create OAuth App**
- Visit [linear.app/settings/api/applications/new](https://linear.app/settings/api/applications/new)
- **Name**: \`20x Desktop\`
- **Redirect URI**: \`nuanu://oauth/callback\`
- Click **Create**

**2. Copy Credentials**
- **Client ID** — Copy from Linear
- **Client Secret** — Click "Show" and copy

**3. Configure in 20x**
- Select **Linear** plugin
- Enter a descriptive name
- Paste **Client ID** and **Client Secret**
- Choose **Permissions**:
  - \`read,write,issues:create,comments:create\` (recommended)

**4. Connect**
- Click **Connect to Linear**
- Authorize in the browser
- Click **Add** to save

---

## HubSpot Setup

### Option A: OAuth (Recommended)

**1. Create OAuth App**
- Follow [HubSpot Quickstart](https://developers.hubspot.com/docs/getting-started/quickstart)
- **Redirect URI**: \`http://localhost:3000/callback\`
- Required scopes:
  - \`tickets\`, \`crm.objects.contacts.read\`
  - \`crm.objects.owners.read\`, \`files\`
  - \`forms-uploaded-files\`

**2. Copy Credentials**
- Go to **Auth** tab
- Copy **Client ID** and **Client Secret**

**3. Configure in 20x**
- Select **HubSpot** plugin
- Choose **OAuth 2.0**
- Paste credentials
- Click **Connect to HubSpot**

### Option B: Private App

**1. Create Private App**
- Go to **Settings → Integrations → Private Apps**
- Click **Create private app**
- Enable all required scopes (above)

**2. Copy Access Token**
- Click **Show token**
- Copy the token (\`pat-...\`)

**3. Configure in 20x**
- Select **HubSpot** plugin
- Choose **Private App Access Token**
- Paste your token

---

## Peakflo Setup

**1. Generate API Key**
- Log in to Peakflo
- Go to **Settings → API Keys**
- Click **Generate New Key**
- Copy the key (shown only once!)

**2. Configure in 20x**
- Select **Peakflo** plugin
- Enter a descriptive name
- Paste your **API Key**
- Click **Add**

---

## Tips

✅ **OAuth credentials are encrypted** using Electron \`safeStorage\`

✅ **All data stays local** — No cloud sync

⚠️ **Don't share API keys** — Treat them like passwords

🔄 **Manual sync** — Click **↻ Sync** to import new tasks

📚 **Full guide**: See \`TASK_SOURCES.md\` in the project root
`

export function TaskSourceGuide() {
  return (
    <div className="h-full overflow-y-auto pr-4 text-sm">
      <ReactMarkdown
        components={{
          h1: ({ ...props }) => <h1 className="text-lg font-semibold mb-2 text-foreground" {...props} />,
          h2: ({ ...props }) => <h2 className="text-base font-semibold mt-4 mb-2 text-foreground" {...props} />,
          h3: ({ ...props }) => <h3 className="text-sm font-semibold mt-3 mb-1.5 text-foreground" {...props} />,
          p: ({ ...props }) => <p className="text-muted-foreground mb-2 leading-relaxed" {...props} />,
          ul: ({ ...props }) => <ul className="list-disc list-inside mb-2 space-y-1 text-muted-foreground" {...props} />,
          ol: ({ ...props }) => <ol className="list-decimal list-inside mb-2 space-y-1 text-muted-foreground" {...props} />,
          li: ({ ...props }) => <li className="text-muted-foreground" {...props} />,
          strong: ({ ...props }) => <strong className="font-semibold text-foreground" {...props} />,
          code: ({ ...props }) => (
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground" {...props} />
          ),
          hr: ({ ...props }) => <hr className="border-border my-4" {...props} />,
          a: ({ ...props }) => (
            <a
              className="text-primary hover:underline cursor-pointer"
              onClick={(e) => {
                e.preventDefault()
                const href = (e.target as HTMLAnchorElement).href
                if (href && window.electronAPI?.shell) {
                  window.electronAPI.shell.openExternal(href)
                }
              }}
              {...props}
            />
          )
        }}
      >
        {TASK_SOURCE_GUIDE}
      </ReactMarkdown>
    </div>
  )
}
