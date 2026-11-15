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
const exportVarMock = jest.spyOn(core, 'exportVariable').mockImplementation()
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

  it('installs a pinned CLI version, exports registry_url, and authenticates in working_directory', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
        case 'pbuf_token':
          return 'pbuf_token_test'
        case 'registry_url':
          return 'https://registry.acme.internal:6777/'
        case 'registry_insecure':
          return 'true'
        case 'working_directory':
          return 'services/billing'
        default:
          return ''
      }
    })

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(exportVarMock).toHaveBeenCalledWith(
      'PBUF_REGISTRY_ADDR',
      'registry.acme.internal:6777'
    )
    expect(exportVarMock).toHaveBeenCalledWith('PBUF_REGISTRY_INSECURE', 'true')
    expect(setSecretMock).toHaveBeenCalledWith('pbuf_token_test')
    expect(infoMock).toHaveBeenCalledWith('Installing pbuf cli version v0.17.1')
    expect(execMock).toHaveBeenCalledWith('/bin/bash', [
      '-lc',
      'curl -fsSL https://raw.githubusercontent.com/pbufio/pbuf-registry/main/scripts/install.sh | sh -s -- -v "$1"',
      '_',
      'v0.17.1'
    ])
    expect(ioWhichMock).toHaveBeenCalledWith('pbuf', true)
    expect(execMock).toHaveBeenCalledWith('pbuf', ['auth', 'pbuf_token_test'], {
      cwd: 'services/billing',
      silent: true
    })
  })

  it('rejects malformed registry_url inputs', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
        case 'registry_url':
          return 'bad host/path;rm'
        default:
          return ''
      }
    })

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid registry_url "bad host/path;rm" (expected host[:port])'
    )
    expect(execMock).not.toHaveBeenCalled()
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

  it('strips log.Fatalf stdout trailer, writes step summary, and posts sticky PR comment', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    const summaryFile = path.join(tempDir, 'summary.md')
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { number: 42 } })
    )
    fs.writeFileSync(summaryFile, '')
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'
    process.env.GITHUB_STEP_SUMMARY = summaryFile

    const cleanReport =
      '### Schema Drift Diff: `pbufio/example` (against `v1.0.0`)\n\n| Severity | File | Change | Details |\n| :--- | :--- | :--- | :--- |\n| **CRITICAL** | `api/v1/user.proto` | `FIELD_REMOVED` | field User#2 (string email) was removed |'
    const cliStdout = `${cleanReport}\n2026/11/15 10:00:00 failed to execute command: schema drift check failed: detected changes meeting or exceeding CRITICAL severity\n`
    const cliStderr =
      'Error: schema drift check failed: detected changes meeting or exceeding CRITICAL severity\nUsage:\n  pbuf drift diff [flags]\n'

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
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
        options.listeners.stdout(Buffer.from(cliStdout))
        options.listeners.stderr(Buffer.from(cliStderr))
        return 1
      }
      return 0
    })

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            id: 10,
            body: `Reviewer note quoting \`${main.COMMENT_MARKER}\` inline`
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 99 })
      })

    await main.run()

    expect(setOutputMock).toHaveBeenCalledWith('drift_markdown', cleanReport)
    expect(setOutputMock).toHaveBeenCalledWith('drift_exit_code', '1')
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain(cleanReport)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/pbufio/example-protos/issues/42/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          body: `${main.COMMENT_MARKER}\n${cleanReport}`
        })
      })
    )
    expect(setFailedMock).toHaveBeenCalledWith(
      'Error: schema drift check failed: detected changes meeting or exceeding CRITICAL severity'
    )

    fetchMock.mockRestore()
  })

  it('does not post raw CLI fatal errors as PR comments when drift diff fails before rendering', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { number: 15 } })
    )
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
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
        options.listeners.stdout(
          Buffer.from(
            '2026/11/15 10:00:00 failed to execute command: failed to fetch module acme/orders: rpc error: code = Unauthenticated\n'
          )
        )
        return 1
      }
      return 0
    })

    const fetchMock = jest.spyOn(global, 'fetch')
    await main.run()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(setOutputMock).toHaveBeenCalledWith('drift_markdown', '')
    expect(setFailedMock).toHaveBeenCalledWith(
      'failed to fetch module acme/orders: rpc error: code = Unauthenticated'
    )

    fetchMock.mockRestore()
  })

  it('paginates via Link header and updates directory-scoped sticky PR comment with truncation', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7 } }))
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'

    const hugeReport = `### Schema Drift Diff: \`pbufio/orders\` (against \`v1.0.0\`)\n\n${'x'.repeat(60100)}`

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
        case 'drift_diff':
          return 'true'
        case 'working_directory':
          return './proto/orders/'
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
        options.listeners.stdout(Buffer.from(hugeReport))
        return 0
      }
      return 0
    })

    const scopedMarker = '<!-- pbuf-drift-diff:proto/orders -->'
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: h =>
            h === 'link'
              ? '<https://api.github.com/repositories/1/issues/7/comments?page=2>; rel="next"'
              : null
        },
        json: async () => [
          { id: 111, body: `${main.COMMENT_MARKER}\nother module report` }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          { id: 555, body: `${scopedMarker}\nold orders report` }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 555 })
      })

    await main.run()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/pbufio/example-protos/issues/comments/555',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('_...report truncated..._')
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
          return 'v0.17.1'
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
          return 'v0.17.1'
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
