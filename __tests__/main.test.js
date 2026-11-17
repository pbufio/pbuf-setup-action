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
const errorMock = jest.spyOn(core, 'error').mockImplementation()
const infoMock = jest.spyOn(core, 'info').mockImplementation()
const warningMock = jest.spyOn(core, 'warning').mockImplementation()
const getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
const getStateMock = jest.spyOn(core, 'getState').mockImplementation(() => '')
const saveStateMock = jest.spyOn(core, 'saveState').mockImplementation()
const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
const setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
const setSecretMock = jest.spyOn(core, 'setSecret').mockImplementation()
const exportVarMock = jest.spyOn(core, 'exportVariable').mockImplementation()
const execMock = jest.spyOn(exec, 'exec').mockImplementation()
const homedirMock = jest.spyOn(os, 'homedir')

describe('action', () => {
  const originalEnv = process.env
  const { osName, archName } = main.resolvePlatform()
  let tempDir
  let toolCacheDir
  let fakeHome

  beforeEach(() => {
    jest.clearAllMocks()
    getStateMock.mockReturnValue('')
    process.env = { ...originalEnv }
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_STEP_SUMMARY
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_API_URL
    delete process.env.GITHUB_WORKSPACE
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbuf-action-test-'))
    fakeHome = path.join(tempDir, 'home')
    fs.mkdirSync(fakeHome, { recursive: true })
    homedirMock.mockReturnValue(fakeHome)
    process.env.RUNNER_TEMP = path.join(tempDir, 'runner-temp')
    toolCacheDir = path.join(tempDir, 'tool-cache')
    process.env.RUNNER_TOOL_CACHE = toolCacheDir
    const cachedDir = path.join(toolCacheDir, 'pbuf', '0.19.0', archName)
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
    const archiveName = `pbuf_0.19.0_${osName}_${archName}.tar.gz`
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
          return 'v0.19.0'
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
      '0.19.0',
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
    expect(infoMock).toHaveBeenCalledWith('Installing pbuf cli version v0.19.0')
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
          return 'v0.19.0'
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
      json: async () => ({ tag_name: 'v0.19.0' })
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
      expect.stringContaining('Reusing cached pbuf v0.19.0')
    )

    fetchMock.mockRestore()
  })

  it('omits GHES token when resolving latest release on api.github.com and uses --help for < v0.17.0', async () => {
    process.env.GITHUB_API_URL = 'https://ghes.acme.internal/api/v3'
    const legacyDir = path.join(toolCacheDir, 'pbuf', '0.16.0', archName)
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacyBin = path.join(legacyDir, 'pbuf')
    fs.writeFileSync(legacyBin, 'legacy-bin', { mode: 0o755 })

    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'latest'
      if (name === 'github_token') return 'ghes_secret_token'
      return ''
    })

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v0.16.0' })
    })

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
    expect(execMock).toHaveBeenCalledWith(legacyBin, ['--help'])
    fetchMock.mockRestore()
  })

  it('retries latest release lookup anonymously on 403 and rejects malformed tag_name', async () => {
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'latest'
      if (name === 'github_token') return 'emu_scoped_token'
      return ''
    })

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: '../evil' })
      })

    await main.run()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid release tag "../evil" returned by GitHub API'
    )
    fetchMock.mockRestore()
  })

  it('rejects symlink pbuf entries extracted from release archive', async () => {
    fs.rmSync(toolCacheDir, { recursive: true, force: true })
    const archiveName = `pbuf_0.19.0_${osName}_${archName}.tar.gz`
    const fakeArchive = Buffer.from('symlink-tar')
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
        fs.symlinkSync('/etc/passwd', path.join(args[destIdx + 1], 'pbuf'))
      }
      return 0
    })

    getInputMock.mockImplementation(name =>
      name === 'version' ? 'v0.19.0' : ''
    )

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      `Regular pbuf binary not found in ${archiveName}`
    )
    expect(addPathMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('fails installation when SHA-256 checksum does not match checksums.txt', async () => {
    fs.rmSync(toolCacheDir, { recursive: true, force: true })
    const archiveName = `pbuf_0.19.0_${osName}_${archName}.tar.gz`
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
      name === 'version' ? '0.19.0' : ''
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

    const archiveName = `pbuf_0.19.0_${osName}_${archName}.tar.gz`
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
      name === 'version' ? 'v0.19.0' : ''
    )

    await main.run()

    const fallbackBin = path.join(fakeHome, '.local', 'bin', 'pbuf')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackBin)).toBe(true)
    expect(addPathMock).toHaveBeenCalledWith(
      path.join(fakeHome, '.local', 'bin')
    )

    fetchMock.mockRestore()
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
          return 'v0.19.0'
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
          return 'v0.19.0'
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
          return 'v0.19.0'
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
          return 'v0.19.0'
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
          return 'v0.19.0'
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
          return 'v0.19.0'
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

  it('runs offline pbuf lint with quoted/multiline lint_paths and sets lint_exit_code=0', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'lint':
          return 'true'
        case 'lint_paths':
          return 'api\n"my service"/proto \'third/dir\' ""'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(
          Buffer.from(JSON.stringify({ files: 4, findings: [] }))
        )
        return 0
      }
      return 0
    })

    await main.run()

    expect(execMock).toHaveBeenCalledWith(
      'pbuf',
      ['lint', '-o', 'json', '--', 'api', 'my service/proto', 'third/dir'],
      expect.objectContaining({
        cwd: undefined,
        ignoreReturnCode: true,
        silent: true
      })
    )
    expect(setOutputMock).toHaveBeenCalledWith('lint_exit_code', '0')
    expect(infoMock).toHaveBeenCalledWith(
      'pbuf lint passed (4 file(s) checked, 0 violations).'
    )
    expect(errorMock).not.toHaveBeenCalled()
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('emits GitHub PR file annotations for pbuf lint violations, caps at 50, and still runs drift_diff', async () => {
    process.env.GITHUB_WORKSPACE = '/workspace/repo'
    const findings = [
      {
        filename: 'proto/billing.proto',
        line: 14,
        column: 3,
        rule: 'FIELD_NAME',
        message: 'field "userId" should be snake_case'
      },
      {
        filename: '../shared/empty.proto',
        line: 0,
        column: 0,
        rule: 'SYNTAX',
        message: 'file is empty'
      }
    ]
    for (let i = 0; i < 50; i += 1) {
      findings.push({
        filename: 'proto/extra.proto',
        line: i + 1,
        column: 1,
        rule: 'MESSAGE_NAME',
        message: `message bad_${i} should be PascalCase`
      })
    }

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'working_directory':
          return './services/billing/'
        case 'lint':
          return 'true'
        case 'drift_diff':
          return 'true'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(
          Buffer.from(JSON.stringify({ files: 3, findings }))
        )
        options.listeners.stderr(
          Buffer.from(
            'failed to execute command: lint failed: 52 violation(s) found\n'
          )
        )
        return 1
      }
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(Buffer.from('No schema changes detected.\n'))
        return 0
      }
      return 0
    })

    await main.run()

    expect(setOutputMock).toHaveBeenCalledWith('lint_exit_code', '1')
    expect(errorMock).toHaveBeenCalledTimes(50)
    expect(errorMock).toHaveBeenNthCalledWith(
      1,
      '[FIELD_NAME] field "userId" should be snake_case',
      {
        title: 'pbuf lint (FIELD_NAME)',
        file: 'services/billing/proto/billing.proto',
        startLine: 14,
        startColumn: 3
      }
    )
    expect(errorMock).toHaveBeenNthCalledWith(2, '[SYNTAX] file is empty', {
      title: 'pbuf lint (SYNTAX)',
      file: 'services/shared/empty.proto'
    })
    expect(warningMock).toHaveBeenCalledWith(
      'Showing first 50 of 52 pbuf lint violations.'
    )
    expect(setFailedMock).toHaveBeenCalledWith(
      'pbuf lint failed: 52 violation(s) found across 3 file(s)'
    )
    expect(setOutputMock).toHaveBeenCalledWith('drift_exit_code', '0')
  })

  it('surfaces clean CLI error when pbuf lint fails before rendering JSON', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'lint':
          return 'true'
        default:
          return ''
      }
    })

    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stderr(
          Buffer.from(
            'failed to execute command: no .proto files found in api\n'
          )
        )
        return 1
      }
      return 0
    })

    await main.run()

    expect(setOutputMock).toHaveBeenCalledWith('lint_exit_code', '1')
    expect(setFailedMock).toHaveBeenCalledWith('no .proto files found in api')
  })

  it('fails cleanly when lint is enabled with pbuf CLI older than v0.19.0', async () => {
    const oldDir = path.join(toolCacheDir, 'pbuf', '0.18.0', archName)
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'pbuf'), '#!/bin/sh\n', { mode: 0o755 })

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.18.0'
        case 'lint':
          return 'true'
        default:
          return ''
      }
    })

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      'pbuf lint requires pbuf CLI v0.19.0 or newer (installed v0.18.0)'
    )
    expect(execMock).not.toHaveBeenCalledWith(
      'pbuf',
      expect.arrayContaining(['lint']),
      expect.anything()
    )
  })

  it('supportsLint, parseLintPaths, and resolveAnnotationFile handle version, quote, chunk, and path edge cases', async () => {
    expect(main.supportsLint('0.18.0')).toBe(false)
    expect(main.supportsLint('0.19.0')).toBe(true)
    expect(main.supportsLint('0.19.0-rc.1')).toBe(true)
    expect(main.supportsLint('1.0.0')).toBe(true)

    expect(() => main.parseLintPaths('"unclosed/path')).toThrow(
      'Unclosed quote in lint_paths'
    )

    process.env.GITHUB_WORKSPACE = '/workspace/repo'
    expect(main.resolveAnnotationFile('', 'services/a')).toBeUndefined()
    expect(
      main.resolveAnnotationFile(
        '/workspace/repo/api/v1/order.proto',
        'services/a'
      )
    ).toBe('api/v1/order.proto')
    expect(
      main.resolveAnnotationFile('api/hello.proto', '/tmp/pbuf-smoke')
    ).toBe('/tmp/pbuf-smoke/api/hello.proto')

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'lint':
          return 'true'
        default:
          return ''
      }
    })

    const utf8Json = Buffer.from(
      JSON.stringify({ files: 1, findings: [] }),
      'utf8'
    )
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(utf8Json.subarray(0, 5))
        options.listeners.stdout(utf8Json.subarray(5))
        return 137
      }
      return 0
    })

    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'pbuf lint failed with exit code 137'
    )
  })

  it('backs up pre-existing ~/.netrc before auth and restores or deletes it in post hook', async () => {
    const netrcPath = path.join(fakeHome, '.netrc')
    fs.writeFileSync(netrcPath, 'machine github.com login git password tok\n', {
      mode: 0o600
    })

    const savedState = {}
    saveStateMock.mockImplementation((key, val) => {
      savedState[key] = val
    })
    getStateMock.mockImplementation(key => savedState[key] || '')

    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.19.0'
      if (name === 'pbuf_token') return 'pbuf_secret_tok'
      return ''
    })

    execMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'pbuf' && args[0] === 'auth') {
        fs.writeFileSync(
          netrcPath,
          'machine pbuf.cloud login user password pbuf_secret_tok\n'
        )
      }
      return 0
    })

    await main.run()
    expect(savedState.isPost).toBe('true')
    expect(savedState.netrcMode).toBe('restore')
    expect(fs.existsSync(savedState.netrcBackupPath)).toBe(true)

    // Run post-job cleanup -> restores original ~/.netrc and removes backup
    await main.run()
    expect(fs.readFileSync(netrcPath, 'utf8')).toBe(
      'machine github.com login git password tok\n'
    )
    expect(fs.existsSync(savedState.netrcBackupPath)).toBe(false)

    // Fresh run without prior ~/.netrc -> post-job deletes ~/.netrc
    fs.rmSync(netrcPath, { force: true })
    for (const key of Object.keys(savedState)) {
      delete savedState[key]
    }
    await main.run()
    expect(savedState.netrcMode).toBe('delete')
    expect(fs.existsSync(netrcPath)).toBe(true)

    await main.run()
    expect(fs.existsSync(netrcPath)).toBe(false)

    // Symlinked ~/.netrc -> target stays untouched and symlink is restored in post
    const dotfileNetrc = path.join(tempDir, 'dotfiles-netrc')
    fs.writeFileSync(
      dotfileNetrc,
      'machine corp.internal login ci password keepme\n',
      { mode: 0o600 }
    )
    fs.symlinkSync(dotfileNetrc, netrcPath)
    for (const key of Object.keys(savedState)) {
      delete savedState[key]
    }
    execMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'pbuf' && args[0] === 'auth') {
        fs.appendFileSync(
          netrcPath,
          'machine pbuf.cloud login user password pbuf_secret_tok\n'
        )
      }
      return 0
    })

    await main.run()
    expect(savedState.netrcMode).toBe('symlink')
    expect(fs.lstatSync(netrcPath).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(dotfileNetrc, 'utf8')).toBe(
      'machine corp.internal login ci password keepme\n'
    )

    await main.run()
    expect(fs.lstatSync(netrcPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(netrcPath)).toBe(dotfileNetrc)
    expect(fs.readFileSync(dotfileNetrc, 'utf8')).toBe(
      'machine corp.internal login ci password keepme\n'
    )
  })

  it('retries transient 503/429, network errors, and mid-stream body drops in fetchWithRetry', async () => {
    const cancelMock = jest.fn().mockResolvedValue()
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('mid-stream reset')
        }
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: cancelMock }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'ok-body'
      })

    const { res, bodyData } = await main.fetchWithRetry(
      'https://example.com',
      {},
      5000,
      4,
      0,
      r => r.text()
    )
    expect(res.status).toBe(200)
    expect(bodyData).toBe('ok-body')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(cancelMock).toHaveBeenCalledTimes(1)
    fetchMock.mockRestore()
  })

  it('rejects invalid boolean inputs, handles non-PR/issue_comment events, truncates at newline, and validates platform/JSON errors', async () => {
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.19.0'
      if (name === 'drift_diff') return 'yes'
      return ''
    })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid boolean input drift_diff="yes" (expected true or false)'
    )

    expect(() => main.resolvePlatform('win32', 'x64')).toThrow(
      'Unsupported operating system "win32"'
    )
    expect(() => main.resolvePlatform('linux', 'ia32')).toThrow(
      'Unsupported architecture "ia32"'
    )
    expect(() =>
      main.parseExpectedChecksum('deadbeef  other.tar.gz\n', 'missing.tar.gz')
    ).toThrow('Checksum entry for missing.tar.gz not found')

    const tableMarkdown = `${'row-line\n'.repeat(6665)}trailing-cut-row`
    const truncated = main.truncateMarkdown(tableMarkdown)
    expect(truncated).toContain('_...report truncated..._')
    expect(truncated).not.toContain('trailing-cut-row')

    // Non-PR push event skips comment cleanly
    jest.clearAllMocks()
    getStateMock.mockReturnValue('')
    const eventFile = path.join(tempDir, 'push-event.json')
    fs.writeFileSync(eventFile, JSON.stringify({ ref: 'refs/heads/main' }))
    process.env.GITHUB_EVENT_PATH = eventFile
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'lint':
          return 'true'
        case 'drift_diff':
          return 'true'
        case 'comment_on_pr':
          return 'true'
        default:
          return ''
      }
    })
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(Buffer.from('not-json'))
        return 1
      }
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(
          Buffer.from('### Schema Drift Diff: `acme/orders`\n')
        )
        return 0
      }
      return 0
    })
    await main.run()
    expect(infoMock).toHaveBeenCalledWith(
      'Skipping PR comment: workflow event is not a pull request'
    )
    expect(setFailedMock).toHaveBeenCalledWith('not-json')
  })
})
