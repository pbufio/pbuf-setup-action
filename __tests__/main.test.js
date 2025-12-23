/**
 * Unit tests for the action's main functionality, src/main.js
 */
const core = require('@actions/core')
const io = require('@actions/io')
const os = require('os')
const exec = require('@actions/exec')
const main = require('../src/main')

// Mock the GitHub Actions core library
const infoMock = jest.spyOn(core, 'info').mockImplementation()
const getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
const setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
const ioWhichMock = jest.spyOn(io, 'which').mockImplementation()
const osPlatformMock = jest.spyOn(os, 'platform').mockImplementation()
const osArchMock = jest.spyOn(os, 'arch').mockImplementation()
const execMock = jest.spyOn(exec, 'exec').mockImplementation()

// Mock the action's main function
const runMock = jest.spyOn(main, 'run')

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('calls the main function', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.3.0'
        case 'pbuf_token':
          return 'pbuf_token_test'
        default:
          return ''
      }
    })

    osPlatformMock.mockReturnValue('linux')
    osArchMock.mockReturnValue('x64')

    await main.run()

    expect(runMock).toHaveReturned()

    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Installing pbuf cli version v0.3.0'
    )

    expect(setFailedMock).not.toHaveBeenCalled()

    // Check that we run the official install script with the provided version
    expect(execMock).toHaveBeenCalledWith('/bin/bash', [
      '-lc',
      expect.stringContaining(
        'curl -fsSL https://raw.githubusercontent.com/pbufio/pbuf-cli/main/install.sh | sh -s -- -v v0.3.0'
      )
    ])

    expect(ioWhichMock).toHaveBeenNthCalledWith(1, 'pbuf', true)

    expect(execMock).toHaveBeenCalledWith('pbuf', ['auth', 'pbuf_token_test'])
  })
})
