# Implementation Plan: Task Source Setup Documentation UI

## Overview
Add a documentation panel to the Task Source configuration modal that displays step-by-step setup instructions for each plugin (Linear, HubSpot, Peakflo Workflows).

## Current State Analysis

### Existing Structure
- **Modal**: `TaskSourceFormDialog.tsx` - Currently uses `max-w-lg` (512px width)
- **Plugin Forms**: Custom forms for each plugin (Linear, HubSpot, Peakflo)
- **Markdown Support**: `react-markdown` already installed in package.json
- **Documentation**: Existing LINEAR_OAUTH_SETUP.md in `/docs` folder

### Design Constraints
- Dialog uses Radix UI with fixed positioning
- Current layout is single-column form
- Need to maintain responsive design
- Should work with existing plugin architecture

## Implementation Strategy

### 1. Add Documentation to Plugin Interface

**Files to modify:**
- `src/main/plugins/types.ts` - Add optional `getSetupDocumentation()` method to `TaskSourcePlugin` interface
- `src/main/plugins/linear-plugin.ts` - Implement documentation method
- `src/main/plugins/hubspot-plugin.ts` - Implement documentation method
- `src/main/plugins/peakflo-plugin.ts` - Implement documentation method

**Approach:**
- Add method that returns markdown string
- Keep documentation co-located with plugin code (not separate .md files)
- Documentation should be embedded in the plugin class for easier maintenance

### 2. Create Documentation Component

**New file:** `src/renderer/src/components/plugins/PluginSetupDocumentation.tsx`

**Features:**
- Renders markdown using react-markdown
- Styled documentation panel with different background
- Scrollable content area
- Clean, readable typography

### 3. Modify Task Source Dialog Layout

**Files to modify:**
- `src/renderer/src/components/settings/forms/TaskSourceFormDialog.tsx`

**Layout Changes:**
- Change from single column to two-column layout
- Left side: Existing form (narrower)
- Right side: Documentation panel (wider)
- Increase modal width from `max-w-lg` (512px) to `max-w-6xl` (1152px)
- Use flexbox or grid layout for responsive split

**Responsive Behavior:**
- Desktop: Side-by-side layout (60/40 split approximately)
- Mobile/small screens: Stack vertically (documentation below form)

### 4. Expose Documentation via IPC

**Files to modify:**
- `src/main/plugins/registry.ts` - Add method to get plugin documentation
- `src/main/ipc-handlers.ts` - Add IPC handler for fetching documentation
- `src/renderer/src/lib/ipc-client.ts` - Add client method for documentation
- `src/renderer/src/types/index.ts` - Update PluginMeta type if needed

**Data Flow:**
```
TaskSourceFormDialog -> pluginApi.getDocumentation(pluginId)
  -> IPC Handler -> PluginRegistry.getDocumentation(id)
  -> Plugin.getSetupDocumentation() -> Returns Markdown
```

### 5. Write Documentation Content

**For each plugin, create comprehensive setup guide:**

**Linear Documentation:**
- Prerequisites
- Step 1: Create OAuth Application in Linear
- Step 2: Configure Redirect URI
- Step 3: Copy Credentials
- Step 4: Select Permissions
- Step 5: Connect & Authorize
- Troubleshooting tips

**HubSpot Documentation:**
- Prerequisites
- Choose authentication method (OAuth vs Private App)
- OAuth Setup:
  - Step 1: Create OAuth app
  - Step 2: Configure redirect URIs
  - Step 3: Copy credentials
- Private App Setup:
  - Step 1: Create Private App
  - Step 2: Configure scopes
  - Step 3: Copy access token
- Step 4: Connect & Sync
- Troubleshooting tips

**Peakflo Workflows Documentation:**
- Prerequisites
- Step 1: Set up MCP Server
- Step 2: Configure API credentials
- Step 3: Select status filter
- Step 4: Test connection
- Troubleshooting tips

## File Changes Summary

### New Files
1. `src/renderer/src/components/plugins/PluginSetupDocumentation.tsx` - Markdown renderer component

### Modified Files
1. `src/main/plugins/types.ts` - Add `getSetupDocumentation()` method
2. `src/main/plugins/linear-plugin.ts` - Implement documentation
3. `src/main/plugins/hubspot-plugin.ts` - Implement documentation
4. `src/main/plugins/peakflo-plugin.ts` - Implement documentation
5. `src/main/plugins/registry.ts` - Add method to fetch documentation
6. `src/main/ipc-handlers.ts` - Add IPC handler
7. `src/renderer/src/lib/ipc-client.ts` - Add client method
8. `src/renderer/src/components/settings/forms/TaskSourceFormDialog.tsx` - Two-column layout
9. `src/renderer/src/components/plugins/index.tsx` - Export new documentation component (if needed)

## Technical Decisions

### Why embed docs in plugin code vs separate .md files?
- **Pro embed**: Co-location, easier maintenance, type-safe
- **Pro separate**: Easier to edit, better for non-developers
- **Decision**: Embed in code - keeps documentation in sync with plugin implementation

### Why two-column vs tabs/accordion?
- **Pro two-column**: Documentation always visible, easier to reference while filling form
- **Pro tabs**: More compact, works better on small screens
- **Decision**: Two-column with responsive fallback - better UX for setup flow

### Styling Approach
- Use muted background color for documentation panel (e.g., `bg-muted/50`)
- Add border between columns
- Use prose styling for markdown (Tailwind Typography if available, or custom)
- Ensure good contrast and readability

## Implementation Order

1. ✅ Add `getSetupDocumentation()` to plugin interface
2. ✅ Implement documentation in each plugin class
3. ✅ Create PluginSetupDocumentation component
4. ✅ Add IPC handler and client methods
5. ✅ Modify TaskSourceFormDialog layout
6. ✅ Test with each plugin type
7. ✅ Polish styling and responsive behavior

## Testing Plan

- [ ] Test Linear plugin documentation display
- [ ] Test HubSpot plugin documentation display
- [ ] Test Peakflo plugin documentation display
- [ ] Test responsive layout on different screen sizes
- [ ] Test modal scrolling behavior
- [ ] Test switching between plugins (documentation updates correctly)
- [ ] Test markdown rendering (headings, lists, code blocks, links)

## Success Criteria

- Documentation panel appears on right side of Task Source modal
- Each plugin displays relevant setup instructions
- Layout is responsive and readable
- Documentation updates when plugin selection changes
- Markdown renders correctly with proper styling
- No regression in existing form functionality
