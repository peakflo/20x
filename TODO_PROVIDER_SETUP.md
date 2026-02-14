# TODO: Complete Provider Setup Integration

## Step 1: Add Provider Step to Onboarding

In `DepsWarningBanner.tsx`:

```typescript
// Import the component
import { ProviderSetupStep } from '@/components/providers/ProviderSetupDialog'

// In the component, add provider step rendering:
{current.kind === 'provider' ? (
  <ProviderSetupStep
    error={error}
    setError={setError}
    onComplete={() => {
      if (isLast) {
        setDismissed(true)
      } else {
        setStep(step + 1)
      }
    }}
  />
) : /* existing steps */}

// Add PROVIDER_STEP constant:
const PROVIDER_STEP: ProviderStepDef = { kind: 'provider' }

// Update step initialization to include provider step:
const depSteps = /* ... */
const providerSteps = [PROVIDER_STEP]  // Always show provider setup
const agentSteps = /* ... */
setSteps([...depSteps, ...providerSteps, ...agentSteps])
```

## Step 2: Pass API Keys to SDK Server

In `agent-manager.ts`, update `startServer()`:

```typescript
async startServer(): Promise<void> {
  if (this.serverInstance) {
    console.log('[AgentManager] Server already running')
    return
  }

  if (!OpenCodeSDK) {
    throw new Error('OpenCode SDK not loaded')
  }

  try {
    console.log('[AgentManager] Starting OpenCode embedded server...')

    // Load API keys from settings
    const providers = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']
    const envVars: Record<string, string> = {}

    for (const key of providers) {
      const value = this.db.getSetting(key)
      if (value) {
        envVars[key] = value
        // Set in process.env so SDK can pick it up
        process.env[key] = value
      }
    }

    console.log(`[AgentManager] Loaded ${Object.keys(envVars).length} API key(s)`)

    // Create embedded OpenCode server using SDK
    const { server } = await OpenCodeSDK.createOpencode({
      hostname: '127.0.0.1',
      port: 4096
    })

    this.serverInstance = server
    this.serverUrl = 'http://127.0.0.1:4096'

    console.log(`[AgentManager] OpenCode server started at ${this.serverUrl}`)
  } catch (error) {
    console.error('[AgentManager] Failed to start OpenCode server:', error)
    this.serverInstance = null
    this.serverUrl = null
    throw error
  }
}
```

## Step 3: Test the Flow

1. Delete existing database (fresh start):
   ```bash
   rm -rf ~/Library/Application\ Support/Workflo\ Workspace/
   ```

2. Start app:
   ```bash
   pnpm dev
   ```

3. Expected flow:
   - Install GitHub CLI (if needed)
   - **Add Anthropic API key** ← New step!
   - Create first agent
   - Done!

4. Verify:
   - Agent can load Claude models
   - Provider key is in settings
   - SDK server has API key

## Step 4: Add Settings UI for More Providers (Optional)

Later, add a settings page where users can:
- View configured providers
- Add OpenAI, Google, etc.
- Update existing keys

This can be a simple list in Agent Settings dialog.

## Expected User Flow

```
User opens app
     ↓
Onboarding starts
     ↓
[Skip GitHub CLI if already installed]
     ↓
📋 ADD ANTHROPIC API KEY
   "Get API Key" link → console.anthropic.com
   Enter key: sk-ant-...
   [Continue] or [Skip for now]
     ↓
Create first agent
   (Models loaded from Anthropic!)
     ↓
Done! ✅
```

## Why This Approach?

Following Composio's simple design:
- ✅ One provider to start (Anthropic)
- ✅ Stored in app settings (not `.env`)
- ✅ Passed as env vars to SDK
- ✅ Can add more providers later
- ✅ No complex UI needed

More secure and integrated than Composio's approach!
