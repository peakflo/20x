# macOS Signing & Notarization

This project signs and notarizes macOS release artifacts through `electron-builder` + GitHub Actions.

## Required Apple Assets

1. Apple Developer Program membership
2. `Developer ID Application` certificate exported as `.p12`
3. App-specific password for Apple ID (used by notarytool)
4. Apple Team ID

## GitHub Secrets

Add these repository secrets:

- `CSC_LINK`: base64 content of the `.p12` signing certificate
- `CSC_KEY_PASSWORD`: password used when exporting the `.p12`
- `APPLE_ID`: Apple ID email for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password from appleid.apple.com
- `APPLE_TEAM_ID`: 10-character Apple Team ID

## Build Configuration

- `package.json > build.mac` enables:
  - `hardenedRuntime: true`
  - `entitlements: resources/entitlements.mac.plist`
  - `entitlementsInherit: resources/entitlements.mac.inherit.plist`
- `package.json > build.afterSign` runs `scripts/notarize.js`
- `scripts/notarize.js` notarizes `.app` with `@electron/notarize` when required env vars are present

## CI/CD Flow

The release workflow (`.github/workflows/release.yml`) on tag push:

1. Imports the Apple certificate to the macOS runner keychain
2. Builds app binaries
3. Runs `electron-builder --mac ...`
4. Signs app with Developer ID cert
5. Notarizes app in `afterSign`
6. Uploads signed + notarized `.dmg` and `.zip` artifacts

## Local Signed Build

```bash
export CSC_LINK="<base64-p12>"
export CSC_KEY_PASSWORD="<p12-password>"
export APPLE_ID="<apple-id-email>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<team-id>"
pnpm build:mac
```

Use `SKIP_NOTARIZE=true` only for temporary local testing.
