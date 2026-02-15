# Linear OAuth2 Integration - Setup & Testing Guide

## Overview

This guide walks through setting up and testing the Linear.app OAuth2 integration in pf-desktop.

## Prerequisites

1. A Linear workspace (free or paid)
2. pf-desktop installed and running
3. Linear OAuth application credentials

## Setup Steps

### 1. Create Linear OAuth Application

1. Go to https://linear.app/settings/api/applications/new
2. Fill in the application details:
   - **Application name**: `pf-desktop` (or your preferred name)
   - **Description**: "Desktop task management integration"
   - **Redirect URI**: `pf-desktop://oauth/callback`
   - **Scopes**: Select:
     - `read` - Read issues, teams, users
     - `write` - Update issues
     - `issues:create` - Create new issues
     - `comments:create` - Add comments to issues

3. Click **Create Application**
4. Copy the **Client ID** and **Client Secret** (keep these secure!)

### 2. Add Linear as a Task Source

1. Open pf-desktop
2. Go to Settings → Task Sources
3. Click **Add Source**
4. Select **Linear** from the plugin dropdown
5. Enter:
   - **Name**: "Linear - My Team" (or any descriptive name)
   - **OAuth Client ID**: Paste the Client ID from Linear
   - **OAuth Client Secret**: Paste the Client Secret from Linear
   - **Permissions**: Select the scopes you want (defaults to read, write)
6. Click **Connect to Linear**

### 3. OAuth Flow

1. Your browser will open with Linear's authorization page
2. Review the requested permissions
3. Click **Authorize**
4. You'll be redirected to `pf-desktop://oauth/callback`
5. pf-desktop will automatically complete the OAuth flow
6. You should see a success message

### 4. Select Teams (Optional)

After authorization, you can select which Linear teams to import tasks from:

1. In the task source configuration, click the **Teams** dropdown
2. Select one or more teams (or leave empty to import from all teams)
3. Click **Save**

### 5. Sync Tasks

1. Click the **Sync Now** button next to your Linear task source
2. pf-desktop will import all issues from the selected teams
3. Issues will appear in your task list with the source badge "Linear"

## Testing

### Test 1: OAuth Flow

**Expected**: Successfully authorize and receive access token

1. Follow setup steps above
2. Verify browser opens to Linear authorization page
3. Authorize the application
4. Verify pf-desktop shows success message
5. Check database: `sqlite3 ~/.config/pf-desktop/pf-desktop.db "SELECT * FROM oauth_tokens WHERE provider='linear'"`
6. Verify `access_token` and `refresh_token` are encrypted (should be binary blobs)

**Troubleshooting**:
- If browser doesn't open: Check protocol handler registration
- If callback fails: Verify redirect URI matches exactly: `pf-desktop://oauth/callback`
- If authorization fails: Check client credentials are correct

### Test 2: Task Import

**Expected**: Import Linear issues as local tasks

1. Create a test issue in Linear
2. In pf-desktop, click **Sync Now** on your Linear source
3. Verify the test issue appears in pf-desktop
4. Check field mapping:
   - Title matches
   - Description matches
   - Status is correctly mapped
   - Priority is correctly mapped
   - Assignee is correctly mapped (if assigned)
   - Labels are imported

**Status Mapping**:
- Linear "Backlog", "Todo" → pf-desktop "not_started"
- Linear "In Progress" → pf-desktop "agent_working"
- Linear "Review" → pf-desktop "ready_for_review"
- Linear "Done", "Canceled" → pf-desktop "completed"

**Priority Mapping**:
- Linear Urgent (1) → pf-desktop "critical"
- Linear High (2) → pf-desktop "high"
- Linear Medium (3) → pf-desktop "medium"
- Linear Low (4) → pf-desktop "low"

### Test 3: Bidirectional Sync

**Expected**: Updates in pf-desktop sync back to Linear

1. Import a task from Linear
2. In pf-desktop, update the task:
   - Change priority from "medium" to "high"
3. Verify the change syncs to Linear
4. Open the issue in Linear and verify priority changed

**Note**: Currently only priority updates are synced back. Other fields can be added as needed.

### Test 4: Actions

**Expected**: Execute Linear-specific actions

1. Select a task imported from Linear
2. Open the task actions menu
3. Try **Add Comment**:
   - Click "Add Comment"
   - Enter "Test comment from pf-desktop"
   - Execute the action
   - Verify comment appears in Linear

4. Try **Update Priority**:
   - Click "Update Priority"
   - Enter "Urgent"
   - Execute the action
   - Verify priority changes to Urgent in Linear

### Test 5: Token Refresh

**Expected**: Automatically refresh expired access token

Linear OAuth tokens expire after 24 hours. To test refresh:

**Option A: Wait 24 hours**
1. Set up Linear integration
2. Wait 24 hours
3. Click **Sync Now**
4. Verify sync succeeds (token should auto-refresh)

**Option B: Manually expire token**
1. Open database: `sqlite3 ~/.config/pf-desktop/pf-desktop.db`
2. Update token expiry:
   ```sql
   UPDATE oauth_tokens
   SET expires_at = datetime('now', '-1 hour')
   WHERE provider = 'linear';
   ```
3. Click **Sync Now** in pf-desktop
4. Verify token is refreshed and sync succeeds
5. Check logs for "Token refresh" message

### Test 6: Error Handling

**Test 6.1: Invalid Credentials**
1. Create a Linear source with invalid client secret
2. Try to authorize
3. **Expected**: Clear error message about invalid credentials

**Test 6.2: Revoked Token**
1. Set up Linear integration successfully
2. In Linear, go to Settings → Applications → Authorized Applications
3. Revoke access for pf-desktop
4. In pf-desktop, click **Sync Now**
5. **Expected**: Error message: "OAuth token expired. Please re-authenticate."
6. **Expected**: UI shows "Reconnect" button

**Test 6.3: Network Error**
1. Disconnect from internet
2. Click **Sync Now** on Linear source
3. **Expected**: Error message about network connectivity

**Test 6.4: Rate Limiting**
1. Make many rapid API calls (sync repeatedly)
2. **Expected**: Graceful handling of rate limit errors

## Security Verification

### Token Encryption

Verify tokens are encrypted at rest:

```bash
# Open database
sqlite3 ~/.config/pf-desktop/pf-desktop.db

# View oauth_tokens table
SELECT id, provider, length(access_token) as token_size, expires_at FROM oauth_tokens;

# Try to read token (should be binary garbage if encrypted)
SELECT hex(substr(access_token, 1, 20)) FROM oauth_tokens WHERE provider='linear';
```

**Expected**: Tokens should be stored as binary blobs, not plain text

### Protocol Handler Security

Verify the custom protocol handler is registered correctly:

```bash
# macOS
defaults read com.peakflo.pf-desktop

# Should show protocol registration for pf-desktop://
```

### PKCE Implementation

The OAuth flow uses PKCE (Proof Key for Code Exchange) for enhanced security:

1. Code verifier is generated client-side
2. Code challenge is sent in authorization request
3. Code verifier is sent during token exchange
4. Linear verifies the challenge matches

Check logs for PKCE-related messages during OAuth flow.

## Troubleshooting

### OAuth Callback Not Working

**Symptoms**: Browser opens, you authorize, but nothing happens in pf-desktop

**Solutions**:
1. Check if `pf-desktop://` protocol is registered:
   - macOS: `ls -la ~/Library/Preferences/com.peakflo.pf-desktop.plist`
2. Restart pf-desktop to re-register protocol handler
3. Check Linear app redirect URI matches exactly: `pf-desktop://oauth/callback`

### Token Refresh Fails

**Symptoms**: "OAuth token expired. Please re-authenticate." even after refresh

**Solutions**:
1. Check if refresh token is valid in database
2. Verify Linear app is still authorized (not revoked)
3. Check client secret hasn't changed
4. Re-authenticate from scratch

### Import Fails

**Symptoms**: Sync button spins but no tasks imported

**Solutions**:
1. Check browser console for errors
2. Verify teams are selected (or leave empty for all teams)
3. Check if issues exist in selected teams
4. Look for error messages in sync result

## API Reference

### OAuth Endpoints

- **Authorization**: `https://linear.app/oauth/authorize`
- **Token Exchange**: `https://api.linear.app/oauth/token`
- **GraphQL API**: `https://api.linear.app/graphql`

### Linear API Documentation

- OAuth Guide: https://developers.linear.app/docs/oauth
- GraphQL API: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
- API Reference: https://studio.apollographql.com/public/Linear-API/home

## Next Steps

After successful setup:

1. Configure bidirectional sync for more fields
2. Add more actions (change status, update assignee, etc.)
3. Set up automatic sync intervals
4. Configure webhooks for real-time updates (future enhancement)

## Support

For issues or questions:
- GitHub Issues: https://github.com/your-repo/pf-desktop/issues
- Linear API Support: https://linear.app/contact
