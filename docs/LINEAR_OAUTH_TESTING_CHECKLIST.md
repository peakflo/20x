# Linear OAuth Integration - Testing Checklist

## Pre-Flight Checks

- [ ] Linear OAuth app created with correct redirect URI (`pf-desktop://oauth/callback`)
- [ ] Client ID and Client Secret obtained
- [ ] pf-desktop application built and running
- [ ] Database initialized (`~/.config/pf-desktop/pf-desktop.db` exists)

## Security Tests

### Token Encryption
- [ ] Tokens are stored as encrypted blobs (not plain text)
- [ ] `safeStorage.isEncryptionAvailable()` returns true on macOS/Windows
- [ ] Tokens can be decrypted and used successfully
- [ ] Database query shows binary data for access_token field

**Verification Command**:
```bash
sqlite3 ~/.config/pf-desktop/pf-desktop.db \
  "SELECT provider, hex(substr(access_token, 1, 20)) FROM oauth_tokens"
```

### PKCE Implementation
- [ ] Code verifier generated (43-128 chars, base64url)
- [ ] Code challenge created using SHA256
- [ ] Challenge sent in authorization request
- [ ] Verifier sent during token exchange
- [ ] Invalid verifier rejected by Linear

### Protocol Handler
- [ ] `pf-desktop://` protocol registered on app startup
- [ ] OAuth callback URL opens pf-desktop app
- [ ] State parameter validated (prevents CSRF)
- [ ] Invalid state rejected

### Error Handling
- [ ] 401 Unauthorized → "Please re-authenticate" message
- [ ] 403 Forbidden → "Check your OAuth permissions" message
- [ ] Network errors → User-friendly error message
- [ ] Expired tokens → Automatic refresh triggered
- [ ] Failed refresh → Re-auth prompt shown

## Functional Tests

### OAuth Flow
- [ ] Click "Connect to Linear" button
- [ ] Browser opens to Linear authorization page
- [ ] Authorization page shows correct app name
- [ ] Authorization page lists requested scopes
- [ ] Click "Authorize" in Linear
- [ ] Browser redirects to `pf-desktop://oauth/callback`
- [ ] pf-desktop receives callback
- [ ] Token exchange completes successfully
- [ ] Success message shown in UI
- [ ] oauth_tokens record created in database

### Task Import
- [ ] Create test issue in Linear with:
  - Title: "Test OAuth Import"
  - Description: "Testing pf-desktop integration"
  - Priority: High
  - Status: In Progress
  - Assignee: You
  - Labels: "test", "oauth"
  - Due date: Tomorrow
- [ ] Click "Sync Now" in pf-desktop
- [ ] Test issue appears in task list
- [ ] All fields mapped correctly:
  - [ ] Title matches
  - [ ] Description matches
  - [ ] Priority = "high"
  - [ ] Status = "agent_working"
  - [ ] Assignee matches
  - [ ] Labels imported
  - [ ] Due date matches
- [ ] external_id populated
- [ ] source_id references correct task source

### Bidirectional Sync
- [ ] Update task priority in pf-desktop (medium → high)
- [ ] Change syncs to Linear
- [ ] Priority updated in Linear API
- [ ] Linear issue shows new priority

### Actions
- [ ] **Add Comment** action visible for Linear tasks
- [ ] Click "Add Comment"
- [ ] Enter comment text
- [ ] Action executes successfully
- [ ] Comment appears in Linear issue

- [ ] **Update Priority** action visible
- [ ] Click "Update Priority"
- [ ] Enter "Urgent"
- [ ] Priority changes to Urgent in Linear
- [ ] Local task priority updated to "critical"

### Token Refresh
- [ ] Manually expire token in database
- [ ] Wait 5+ minutes (token refresh threshold)
- [ ] Click "Sync Now"
- [ ] Token refresh triggered automatically
- [ ] New access token received
- [ ] `expires_at` updated in database
- [ ] Sync completes successfully

### Team Selection
- [ ] Team dropdown populated via dynamic-select
- [ ] Teams listed with name and key
- [ ] Select specific team
- [ ] Save configuration
- [ ] Sync only imports issues from selected team
- [ ] Deselect team (import from all teams)
- [ ] Sync imports from all teams

## Edge Cases

### Empty States
- [ ] No issues in Linear → Sync reports 0 imported
- [ ] No teams selected → Imports from all teams
- [ ] No assignee on issue → Assignee field empty

### Concurrent Operations
- [ ] Multiple syncs don't interfere with each other
- [ ] Token refresh during sync doesn't fail
- [ ] Sync during OAuth flow doesn't corrupt state

### Data Validation
- [ ] Invalid Linear status → Maps to default "not_started"
- [ ] Invalid priority → Maps to "medium"
- [ ] Missing description → Empty string
- [ ] Null due_date → null (no crash)

### Cleanup
- [ ] Delete task source → OAuth token deleted (cascade)
- [ ] Revoke OAuth in Linear → Re-auth required
- [ ] App quit → OAuth scheduler cleaned up

## Performance Tests

### Import Performance
- [ ] Import 10 issues: < 2 seconds
- [ ] Import 100 issues: < 10 seconds
- [ ] Import 500 issues: < 30 seconds
- [ ] Pagination handles large datasets

### Token Refresh
- [ ] Refresh completes in < 2 seconds
- [ ] No user-visible delay during auto-refresh
- [ ] Background scheduler runs without blocking UI

## Integration Tests

### Multi-Source
- [ ] Multiple Linear sources configured
- [ ] Each source has separate OAuth token
- [ ] Tokens don't interfere with each other
- [ ] Sync all sources simultaneously

### Mixed Sources
- [ ] Linear + Peakflo sources both active
- [ ] Tasks from both sources in same list
- [ ] Correct source badge on each task
- [ ] Actions available only for correct source

## UI/UX Tests

### OAuth Dialog
- [ ] Dialog opens on "Connect to Linear"
- [ ] Loading state shown while waiting for callback
- [ ] Success state shown after authorization
- [ ] Error state shown on failure
- [ ] Retry button works after error
- [ ] Cancel button closes dialog

### Error Messages
- [ ] Clear error messages for common failures
- [ ] Error messages suggest solutions
- [ ] Technical details hidden (not exposed to user)
- [ ] Retry mechanism available

### Status Indicators
- [ ] Syncing indicator shows during sync
- [ ] Last synced timestamp updated
- [ ] Source enabled/disabled toggle works
- [ ] Reconnect button shown when auth fails

## Regression Tests

### After App Restart
- [ ] OAuth tokens persist across restarts
- [ ] Token refresh scheduler restarts
- [ ] Sync works without re-authentication
- [ ] Protocol handler still registered

### After Database Migration
- [ ] oauth_tokens table created
- [ ] Foreign key constraints enforced
- [ ] Indexes created correctly

## Documentation Tests

- [ ] README updated with Linear integration
- [ ] Setup guide is complete and accurate
- [ ] All steps tested and verified
- [ ] Screenshots/GIFs added (if applicable)
- [ ] API documentation accurate

## Deployment Checklist

- [ ] All tests passing
- [ ] No console errors during normal operation
- [ ] Memory leaks checked (long-running refresh scheduler)
- [ ] Security review completed
- [ ] Code reviewed by peer
- [ ] Documentation complete
- [ ] Release notes written

## Success Criteria

All checkboxes must be checked before considering the integration complete.

**Required Tests**:
- Security Tests: 100%
- OAuth Flow: 100%
- Task Import: 100%
- Token Refresh: 100%

**Recommended Tests**:
- Bidirectional Sync: 80%+
- Actions: 80%+
- Edge Cases: 70%+
- Performance: 70%+

## Notes

Record any issues, blockers, or observations here:

---

**Tested By**: _______________
**Date**: _______________
**Version**: _______________
**Result**: PASS / FAIL
