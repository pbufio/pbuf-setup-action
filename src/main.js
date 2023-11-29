const core = require('@actions/core')
const tc = require('@actions/tool-cache')
const os = require('os')
const io = require('@actions/io')
const exec = require('@actions/exec')

async function run() {
  // Get inputs from workflow file
  const version = core.getInput('version')
  const pbuf_token = core.getInput('pbuf_token')

  if (version === '') {
    core.setFailed('You must provide a version')
    return
  }

  core.info(`Installing pbuf-cli version ${version}`)

  if (pbuf_token === '') {
    core.info('No pbuf_token provided, skipping login')
  }

  // check that os is linux or darwin
  if (os.platform() !== 'linux' && os.platform() !== 'darwin') {
    core.setFailed(
      'pbuf-cli can only be installed on Linux/Darwin at the moment'
    )
    return
  }

  // check that arch is amd64 or arm64
  if (os.arch() !== 'x64' && os.arch() !== 'arm64') {
    core.setFailed(
      'pbuf-cli can only be installed on amd64 or arm64 at the moment'
    )
    return
  }

  // Construct the URL for the pbuf-cli binary
  const arch = os.arch() === 'arm64' ? 'arm' : 'amd'
  // add version without leading `v`
  const releaserVersion = version.replace(/^v/, '')

  const url = `https://github.com/pbufio/pbuf-cli/releases/download/${version}/pbuf-cli_${releaserVersion}_linux_${arch}64.tar.gz`

  // Download the pbuf-cli binary
  const downloadPath = await tc.downloadTool(url)

  // Extract the downloaded file
  const extractedPath = await tc.extractTar(downloadPath)

  // Cache the extracted directory
  const cachedPath = await tc.cacheDir(extractedPath, 'pbuf-cli', version)

  // Add the cached directory to the PATH
  core.addPath(cachedPath)

  if ((await io.which('pbuf-cli', true)) === '') {
    core.setFailed('pbuf-cli could not be found in the $PATH')
    return
  }

  if (pbuf_token !== '') {
    core.info(`Authenticate in to the pbuf registry`)

    await exec.exec('pbuf-cli', ['init', 'pbufio/pbuf-setup-action'])
    await exec.exec('pbuf-cli', ['auth', pbuf_token])
  }

  core.info(`Successfully setup pbuf-cli`)
}

module.exports = {
  run
}
