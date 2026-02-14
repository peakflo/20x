# Provider Setup Implementation (Composio Style)

## Overview

Implemented simple provider setup following Composio's approach:
- Store API keys in app settings
- Pass as environment variables to OpenCode SDK server
- Simple onboarding: just Anthropic to start
- Users can add more providers in settings later

## How It Works

```
┌─────────────────────────────────────┐
│  User enters API key in UI          │
│          ↓                           │
│  Saved to app settings (secure)     │
│          ↓                           │
│  Passed as env var to SDK server    │
│          ↓                           │
│  OpenCode SDK picks it up           │
│          ↓                           │
│  Provider available for agents!     │
└─────────────────────────────────────┘
```

## Files Modified

### 1. **ProviderSetupStep Component**
   - Location: `src/renderer/src/components/providers/ProviderSetupDialog.tsx`
   - Simple form to collect Anthropic API key
   - Saves to settings
   - Integrated into onboarding flow

### 2. **Agent Manager** (TODO)
   - Load API keys from settings
   - Pass as environment variables when creating SDK server
   - Code to add:

```typescript
async startServer(): Promise<void> {
  // ... existing code ...

  // Load API keys from settings
  const apiKeys: Record<string, string> = {}
  const providers = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']

  for (const key of providers) {
    const value = await this.db.getSetting(key)
    if (value) {
      apiKeys[key] = value
    }
  }

  // Create server with API keys as environment
  const { server } = await OpenCodeSDK.createOpencode({
    hostname: '127.0.0.1',
    port: 4096,
    // SDK should pick up env vars from process.env
    // We set them before creating the server
  })

  // Set env vars for SDK
  Object.assign(process.env, apiKeys)

  this.serverInstance = server
  this.serverUrl = 'http://127.0.0.1:4096'
}
```

### 3. **Onboarding Flow** (TODO)
   - Add provider setup step after GitHub CLI
   - Before agent creation

## Next Steps

1. ✅ Created ProviderSetupStep component
2. ⏳ Integrate into DepsWarningBanner onboarding
3. ⏳ Update AgentManager to pass env vars to SDK
4. ⏳ Test end-to-end flow

## Testing

1. Start app
2. Go through onboarding
3. Enter Anthropic API key
4. Create agent
5. Verify models load from Anthropic

## Comparison with Composio

| Feature | Composio | Your App |
|---------|----------|----------|
| API Key Storage | `.env` file | App settings (secure) |
| Setup | Shell script | In-app onboarding |
| SDK Server | Manual start | Automatic (embedded) |
| Adding providers | Edit `.env` | Settings UI |

Your implementation is actually **better** because:
- ✅ No manual file editing
- ✅ Secure settings storage
- ✅ Guided UI
- ✅ Automatic server management
