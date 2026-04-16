const path = require('path')

function getMissingNotarizeEnv(env = process.env) {
  const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  return required.filter((key) => !env[key] || String(env[key]).trim() === '')
}

function shouldNotarize(context, env = process.env) {
  if (context.electronPlatformName !== 'darwin') {
    return { enabled: false, reason: 'not darwin build' }
  }

  if (String(env.CI_MANUAL_NOTARIZE || '').toLowerCase() === 'true') {
    return { enabled: false, reason: 'CI_MANUAL_NOTARIZE=true' }
  }

  if (String(env.SKIP_NOTARIZE || '').toLowerCase() === 'true') {
    return { enabled: false, reason: 'SKIP_NOTARIZE=true' }
  }

  const missing = getMissingNotarizeEnv(env)
  if (missing.length > 0) {
    return { enabled: false, reason: `missing env: ${missing.join(', ')}` }
  }

  return { enabled: true, reason: 'enabled' }
}

function getNotarizeOptions(context, env = process.env) {
  const { appInfo } = context.packager
  const appPath = path.join(context.appOutDir, `${appInfo.productFilename}.app`)

  return {
    tool: 'notarytool',
    appBundleId: appInfo.id,
    appPath,
    appleId: env.APPLE_ID,
    appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: env.APPLE_TEAM_ID
  }
}

module.exports = {
  getMissingNotarizeEnv,
  shouldNotarize,
  getNotarizeOptions
}
