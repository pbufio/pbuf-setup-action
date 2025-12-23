const core = require('@actions/core')
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

  core.info(`Installing pbuf cli version ${version}`)

  if (pbuf_token === '') {
    core.info('No pbuf_token provided, skipping login')
  }

  // Install via official install script
  const installCmd = `curl -fsSL https://raw.githubusercontent.com/pbufio/pbuf-cli/main/install.sh | sh -s -- -v ${version}`
  await exec.exec('/bin/bash', ['-lc', installCmd])

  // Verify pbuf is available on PATH
  await io.which('pbuf', true)

  if (pbuf_token !== '') {
    core.info(`Authenticate into the pbuf registry`)
    await exec.exec('pbuf', ['auth', pbuf_token])
  }

  core.info(`Successfully setup pbuf cli`)
}

module.exports = {
  run
}
