# Smart Onboarding Flow

## Overview

The onboarding flow now intelligently detects existing OpenCode servers and only asks for API keys when necessary.

## New Behavior

### Scenario 1: OpenCode CLI Running with Providers ✅

**User has:**
```bash
$ opencode serve
# Server running with configured providers
```

**What happens:**
1. ✅ App detects server at `localhost:4096`
2. ✅ Fetches providers via `config.providers()`
3. ✅ **Skips provider setup** - uses existing providers!
4. ✅ Shows: Install GitHub CLI → Create Agent → Done

**No API key asked!** Uses what's already configured in OpenCode.

### Scenario 2: OpenCode CLI Running WITHOUT Providers

**User has:**
```bash
$ opencode serve
# Server running but no providers configured
```

**What happens:**
1. ✅ App detects server
2. ✅ Fetches providers - finds none
3. ✅ Shows provider setup with **choice of provider**
4. ✅ User selects: Anthropic, OpenAI, or Google
5. ✅ Enters API key for chosen provider
6. ✅ API key stored in app settings
7. ✅ Passed to OpenCode server via `process.env`

### Scenario 3: No OpenCode Server Running

**User has:**
- No OpenCode CLI installed
- OR OpenCode CLI not running

**What happens:**
1. ⚠️ No server detected
2. ✅ Shows provider setup with **choice of provider**
3. ✅ User picks preferred provider
4. ✅ Enters API key
5. ✅ App creates embedded server
6. ✅ API key passed to embedded server

## Provider Selection UI

### Step 1: Choose Provider

```
┌─────────────────────────────────────┐
│  Add an AI Provider                 │
│                                     │
│  Choose your preferred provider     │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Anthropic (Claude)          │   │
│  │ Recommended                 │   │
│  │ Claude Opus, Sonnet, Haiku  │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ OpenAI (GPT)                │   │
│  │ GPT-4, GPT-4 Turbo, GPT-3.5 │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Google AI (Gemini)          │   │
│  │ Gemini 2.0 Flash, 1.5 Pro   │   │
│  └─────────────────────────────┘   │
│                                     │
│  [Skip for now]                     │
└─────────────────────────────────────┘
```

### Step 2: Enter API Key (for chosen provider)

```
┌─────────────────────────────────────┐
│  Add an AI Provider                 │
│                                     │
│  Anthropic (Claude)                 │
│  Claude Opus, Sonnet, Haiku         │
│  [Get API Key ↗]                    │
│                                     │
│  API Key:                           │
│  [sk-ant-...]                       │
│                                     │
│  Your API key is stored securely    │
│                                     │
│  [Back] [Continue] [Skip for now]   │
└─────────────────────────────────────┘
```

## Detection Logic

```typescript
// During onboarding initialization
const providers = await agentConfigApi.getProviders()

if (providers && providers.providers.length > 0) {
  // Found existing providers - skip setup!
  console.log('Using existing providers:', providers.providers)
  skipProviderSetup = true
} else {
  // No providers - show setup
  showProviderSetup = true
}
```

## Benefits

### ✅ Better UX
- Don't ask for info we already have
- Respect existing OpenCode configuration
- Let users choose their preferred provider

### ✅ Works with OpenCode CLI
- If user has OpenCode CLI with providers → seamless
- No duplicate configuration
- Uses existing setup

### ✅ Flexible
- Supports multiple providers (not just Anthropic)
- User picks what they want
- Can skip and configure later

## API Key Storage

### When Using Existing OpenCode Server
```
OpenCode CLI → Has providers configured
                ↓
App → Detects providers
      ↓
      Uses them directly
      ↓
      No API keys stored in app
```

### When No Server or No Providers
```
User → Selects provider
       ↓
       Enters API key
       ↓
App Settings DB → Stores key
                   ↓
                   Sets in process.env
                   ↓
OpenCode Server → Picks up from env
```

## Implementation Files Changed

1. **DepsWarningBanner.tsx**
   - Checks for existing providers before showing provider step
   - Only shows if no providers found

2. **ProviderSetupDialog.tsx**
   - Two-step UI: provider selection → API key entry
   - Supports Anthropic, OpenAI, Google
   - Dynamic based on chosen provider

3. **agent-manager.ts**
   - `getProviders()` gracefully handles no server (returns null)
   - Used during onboarding to detect existing providers

## Testing

### Test 1: With OpenCode CLI + Providers
```bash
# Set up OpenCode with provider
export ANTHROPIC_API_KEY=sk-ant-...
opencode serve

# Start app
pnpm dev

# Expected: Provider setup skipped ✅
```

### Test 2: Fresh Install (No Server)
```bash
# Make sure no OpenCode running
pkill -f opencode

# Start app
pnpm dev

# Expected: Provider setup shown with choices ✅
```

### Test 3: OpenCode Running but No Providers
```bash
# Start OpenCode without API keys
opencode serve

# Start app
pnpm dev

# Expected: Provider setup shown ✅
```
