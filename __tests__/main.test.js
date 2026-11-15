/**
 * Unit tests for the action's main functionality, src/main.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('@actions/core')
const io = require('@actions/io')
const exec = require('@actions/exec')
const main = require('../src/main')

const infoMock = jest.spyOn(core, 'info').mockImplementation()
const warningMock = jest.spyOn(core, 'warning').mockImplementation()
const getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
const setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
const setSecretMock = jest.spyOn(core, 'setSecret').mockImplementation()
const ioWhichMock = jest.spyOn(io, 'which').mockImplementation()
const execMock = jest.spyOn(exec, 'exec').mockImplementation()

describe('action', () => {
  const originalEnv = process.env
  let tempDir

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_STEP_SUMMARY
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_API_URL
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbuf-action-test-'))
    execMock.mockResolvedValue(0)
  })

  afterEach(() => {
    process.env = originalEnv
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('installs a pinned CLI version and authenticates safely', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.16.0'
        case 'pbuf_token':
          return 'pbuf_token_test'
        default:
          return ''
      }
    })

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(setSecretMock).toHaveBeenCalledWith('pbuf_token_test')
    expect(infoMock).toHaveBeenCalledWith('Installing pbuf cli version v0.16.0')
    expect(execMock).toHaveBeenCalledWith('/bin/bash', [
      '-lc',
      'curl -fsSL https://raw.githubusercontent.com/pbufio/pbuf-registry/main/scripts/install.sh | sh -s -- -v "$1"',
      '_',
      'v0.16.0'
    ])
    expect(ioWhichMock).toHaveBeenCalledWith('pbuf', true)
    expect(execMock).toHaveBeenCalledWith('pbuf', ['auth', 'pbuf_token_test'])
  })

  it('supports installing latest version without -v flag', async () => {
    getInputMock.mockImplementation(name =>
      name === 'version' ? 'latest' : ''
    )

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(execMock).toHaveBeenCalledWith('/bin/bash', [
      '-lc',
      'curl -fsSL https://raw.githubusercontent.com/pbufio/pbuf-registry/main/scripts/install.sh | sh'
    ])
  })

  it.each([
    ['', 'You must provide a version'],
    ['v0.16.0; whoami', 'Invalid version "v0.16.0; whoami"']
  ])('rejects invalid version input %j', async (versionInput, expectedErr) => {
    getInputMock.mockImplementation(name =>
      name === 'version' ? versionInput : ''
    )

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(expectedErr)
    expect(execMock).not.toHaveBeenCalled()
  })

  it('posts a new sticky PR comment and fails step when drift exceeds fail_on', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { number: 42 } })
    )
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'

    const report =
      '### Schema Drift Diff: `pbufio/example` (against `v1.0.0`)\n\n| Severity | File | Change | Details |\n| :--- | :--- | :--- | :--- |\n| **CRITICAL** | `api/v1/user.proto` | `FIELD_REMOVED` | field User#2 (string email) was removed |\n'

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.16.0'
        case 'drift_diff':
          return 'true'
        case 'fail_on':
          return 'critical'
        case 'against':
          return 'v1.0.0'
        case 'comment_on_pr':
          return 'true'
        case 'github_token':
          return 'ghs_test_token'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(Buffer.from(report))
        options.listeners.stderr(
          Buffer.from(
            'Error: schema drift check failed: detected changes meeting or exceeding CRITICAL severity\n'
          )
        )
        return 1
      }
      return 0
    })

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 10, body: 'unrelated comment' }]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 99 })
      })

    await main.run()

    expect(execMock).toHaveBeenCalledWith(
      'pbuf',
      [
        'drift',
        'diff',
        '--format=markdown',
        '--fail-on=critical',
        '--against=v1.0.0'
      ],
      expect.objectContaining({ ignoreReturnCode: true })
    )
    expect(setOutputMock).toHaveBeenCalledWith('drift_markdown', report.trim())
    expect(setOutputMock).toHaveBeenCalledWith('drift_exit_code', '1')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/pbufio/example-protos/issues/42/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          body: `${main.COMMENT_MARKER}\n${report.trim()}`
        })
      })
    )
    expect(setFailedMock).toHaveBeenCalledWith(
      'Error: schema drift check failed: detected changes meeting or exceeding CRITICAL severity'
    )

    fetchMock.mockRestore()
  })

  it('updates an existing sticky PR comment instead of creating duplicates', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7 } }))
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'

    const report =
      '### Schema Drift Diff: `pbufio/example` (against `v1.0.0`)\n\nNo schema changes detected.\n'

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.16.0'
        case 'drift_diff':
          return 'true'
        case 'comment_on_pr':
          return 'true'
        case 'github_token':
          return 'ghs_test_token'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(Buffer.from(report))
        return 0
      }
      return 0
    })

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 555, body: `${main.COMMENT_MARKER}\nold report` }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 555 })
      })

    await main.run()

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/pbufio/example-protos/issues/comments/555',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          body: `${main.COMMENT_MARKER}\n${report.trim()}`
        })
      })
    )
    expect(setFailedMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('warns without failing build when fork PR lacks comment write permission', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 9 } }))
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.16.0'
        case 'drift_diff':
          return 'true'
        case 'comment_on_pr':
          return 'true'
        case 'github_token':
          return 'ghs_readonly_token'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(Buffer.from('No schema changes detected.\n'))
        return 0
      }
      return 0
    })

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      .mockResolvedValueOnce({ ok: false, status: 403 })

    await main.run()

    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('POST comment failed with status 403')
    )
    expect(setFailedMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('rejects invalid fail_on threshold', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.16.0'
        case 'drift_diff':
          return 'true'
        case 'fail_on':
          return 'bogus'
        default:
          return ''
      }
    })

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid fail_on "bogus" (must be critical, warning, info, or none)'
    )
  })
})
