const packageJson = require('../package.json')

function getCiMacBuildConfig(baseBuild = packageJson.build) {
  return {
    ...baseBuild,
    mac: {
      ...baseBuild.mac,
      // CI uses explicit notarytool steps after packaging instead of builder-managed notarization.
      notarize: false
    },
    // CI notarizes packaged artifacts explicitly in the workflow.
    afterSign: undefined
  }
}

module.exports = {
  getCiMacBuildConfig
}
