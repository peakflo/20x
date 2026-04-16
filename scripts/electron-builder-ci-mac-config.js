const packageJson = require('../package.json')

function getCiMacBuildConfig(baseBuild = packageJson.build) {
  return {
    ...baseBuild,
    // CI notarizes packaged artifacts explicitly in the workflow.
    afterSign: undefined
  }
}

module.exports = getCiMacBuildConfig()
module.exports.getCiMacBuildConfig = getCiMacBuildConfig
