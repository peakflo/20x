/**
 * electron-builder afterSign hook
 *
 * Notarizes signed macOS builds so users can install/open without Gatekeeper bypasses.
 */

const { notarize } = require('@electron/notarize')
const { shouldNotarize, getNotarizeOptions } = require('./notarize-config')

async function notarizeApp(context) {
  const decision = shouldNotarize(context, process.env)
  if (!decision.enabled) {
    console.log(`[notarize] Skipping notarization: ${decision.reason}`)
    return
  }

  const options = getNotarizeOptions(context, process.env)
  console.log(`[notarize] Submitting ${options.appPath} for notarization`)
  await notarize(options)
  console.log('[notarize] Notarization complete')
}

module.exports = notarizeApp
