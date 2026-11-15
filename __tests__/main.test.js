/**
 * Unit tests for the action's main functionality, src/main.js
 */
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('@actions/core')
const exec = require('@actions/exec')
const main = require('../src/main')

const addPathMock = jest.spyOn(core, 'addPath').mockImplementation()
const infoMock = jest.spyOn(core, 'info').mockImplementation()
const warningMock = jest.spyOn(core, 'warning').mockImplementation()
const getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
const setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
const setSecretMock = jest.spyOn(core, 'setSecret').mockImplementation()
const exportVarMock = jest.spyOn(core, 'exportVariable').mockImplementation()
const execMock = jest.spyOn(exec, 'exec').mockImplementation()

describe('action', () => {
  const originalEnv = process.env
  const { osName, archName } = main.resolvePlatform()
  let tempDir
  let toolCacheDir

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_STEP_SUMMARY
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_API_URL
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbuf-action-test-'))
    toolCacheDir = path.join(tempDir, 'tool-cache')
    process.env.RUNNER_TOOL_CACHE = toolCacheDir
    const cachedDir = path.join(toolCacheDir, 'pbuf', '0.17.1', archName)
    fs.mkdirSync(cachedDir, { recursive: true })
    fs.writeFileSync(path.join(cachedDir, 'pbuf'), '#!/bin/sh\n', {
      mode: 0o755
    })
    execMock.mockResolvedValue(0)
  })

  afterEach(() => {
    process.env = originalEnv
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('downloads pinned CLI tarball, verifies SHA-256 checksum, caches binary, and authenticates in working_directory', async () => {
    fs.rmSync(toolCacheDir, { recursive: true, force: true })
    const archiveName = `pbuf_0.17.1_${osName}_${archName}.tar.gz`
    const fakeArchive = Buffer.from('fake-tar-gz-bytes')
    const archiveSha = crypto
      .createHash('sha256')
      .update(fakeArchive)
      .digest('hex')

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `${archiveSha}  ${archiveName}\n`
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeArchive
      })

    execMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'tar') {
        const destIdx = args.indexOf('-C')
        fs.writeFileSync(path.join(args[destIdx + 1], 'pbuf'), 'binary-data')
      }
      return 0
    })

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

    const expectedInstallDir = path.join(
      toolCacheDir,
      'pbuf',
      '0.17.1',
      archName
    )
    const expectedBin = path.join(expectedInstallDir, 'pbuf')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(exportVarMock).toHaveBeenCalledWith(
      'PBUF_REGISTRY_ADDR',
      'registry.acme.internal:6777'
    )
    expect(exportVarMock).toHaveBeenCalledWith('PBUF_REGISTRY_INSECURE', 'true')
    expect(setSecretMock).toHaveBeenCalledWith('pbuf_token_test')
    expect(infoMock).toHaveBeenCalledWith('Installing pbuf cli version v0.17.1')
    expect(fs.existsSync(expectedBin)).toBe(true)
    expect(addPathMock).toHaveBeenCalledWith(expectedInstallDir)
    expect(execMock).toHaveBeenCalledWith(expectedBin, ['--version'])
    expect(execMock).toHaveBeenCalledWith(
      'pbuf',
      ['auth', '--', 'pbuf_token_test'],
      {
        cwd: 'services/billing',
        silent: true
      }
    )

    fetchMock.mockRestore()
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

  it('resolves latest release via authenticated GitHub API and reuses cached binary', async () => {
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'latest'
      if (name === 'github_token') return 'ghs_release_token'
      return ''
    })

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v0.17.1' })
    })

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/pbufio/pbuf-registry/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghs_release_token'
        })
      })
    )
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining('Reusing cached pbuf v0.17.1')
    )

    fetchMock.mockRestore()
  })

  it('fails installation when SHA-256 checksum does not match checksums.txt', async () => {
    fs.rmSync(toolCacheDir, { recursive: true, force: true })
    const archiveName = `pbuf_0.17.1_${osName}_${archName}.tar.gz`
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `${'a'.repeat(64)}  ${archiveName}\n`
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('tampered-archive')
      })

    getInputMock.mockImplementation(name =>
      name === 'version' ? '0.17.1' : ''
    )

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      expect.stringContaining('SHA-256 checksum mismatch')
    )
    expect(addPathMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('falls back to $HOME/.local/bin when RUNNER_TOOL_CACHE is unset', async () => {
    delete process.env.RUNNER_TOOL_CACHE
    const fakeHome = path.join(tempDir, 'home')
    fs.mkdirSync(fakeHome, { recursive: true })
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(fakeHome)

    const archiveName = `pbuf_0.17.1_${osName}_${archName}.tar.gz`
    const fakeArchive = Buffer.from('rootless-tar')
    const archiveSha = crypto
      .createHash('sha256')
      .update(fakeArchive)
      .digest('hex')

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `${archiveSha}  ${archiveName}\n`
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeArchive
      })

    execMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'tar') {
        const destIdx = args.indexOf('-C')
        fs.writeFileSync(path.join(args[destIdx + 1], 'pbuf'), 'binary-data')
      }
      return 0
    })

    getInputMock.mockImplementation(name =>
      name === 'version' ? 'v0.17.1' : ''
    )

    await main.run()

    const fallbackBin = path.join(fakeHome, '.local', 'bin', 'pbuf')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackBin)).toBe(true)
    expect(addPathMock).toHaveBeenCalledWith(
      path.join(fakeHome, '.local', 'bin')
    )

    fetchMock.mockRestore()
    homedirSpy.mockRestore()
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

  it.each([
    ['https://[::1]/', '::1'],
    ['http://[::1]:6777/', '[::1]:6777'],
    ['::1', '::1'],
    ['127.0.0.1:6777', '127.0.0.1:6777'],
    ['pbuf.io', 'pbuf.io']
  ])('normalizes registry_url %s -> %s', (input, expected) => {
    expect(main.normalizeRegistryAddr(input)).toBe(expected)
  })

  it.each([
    ['[:::::]:6777'],
    ['registry.internal:0'],
    ['registry.internal:70000'],
    ['-bad.host:6777']
  ])('rejects invalid registry_url %s', input => {
    expect(() => main.normalizeRegistryAddr(input)).toThrow(
      'Invalid registry_url'
    )
  })

  it.each([
    ['', main.COMMENT_MARKER],
    ['.', main.COMMENT_MARKER],
    ['./', main.COMMENT_MARKER],
    ['././proto//orders/', '<!-- pbuf-drift-diff:proto/orders -->'],
    ['proto--->->orders--!>\r\n', '<!-- pbuf-drift-diff:proto----orders--! -->']
  ])('builds safe comment marker for %j', (dir, expected) => {
    expect(main.buildCommentMarker(dir)).toBe(expected)
  })

  it('parses multi-line fatal output and non-timestamped CLI errors cleanly', () => {
    const res = main.parseDriftCliOutput(
      'failed to execute command: failed to parse pbuf.yaml:\n  line 4: cannot unmarshal\n',
      '',
      1
    )
    expect(res.markdown).toBe('')
    expect(res.errorMessage).toBe(
      'failed to parse pbuf.yaml:\n  line 4: cannot unmarshal'
    )

    const noTags = main.parseDriftCliOutput(
      'No prior published tags found for acme/orders\n',
      '',
      0
    )
    expect(noTags.markdown).toBe(
      'No prior published tags found for acme/orders'
    )
  })

  it('warns when registry_insecure is set without registry_url and matches CRLF sticky markers', async () => {
    const eventFile = path.join(tempDir, 'event.json')
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 5 } }))
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'
    delete process.env.PBUF_REGISTRY_ADDR

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.17.1'
        case 'registry_insecure':
          return 'true'
        case 'drift_diff':
          return 'true'
        case 'comment_on_pr':
          return 'true'
        case 'github_token':
          return 'ghs_tok'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(
          Buffer.from('### Schema Drift Diff: `acme/orders`\n')
        )
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
          { id: 901, body: `${main.COMMENT_MARKER}\r\nold crlf body` }
        ]
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await main.run()

    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('registry_insecure has no effect')
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/pbufio/example-protos/issues/comments/901',
      expect.objectContaining({ method: 'PATCH' })
    )
    fetchMock.mockRestore()
  })
})
