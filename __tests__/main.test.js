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
const userInfoMock = jest.spyOn(os, 'userInfo')

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
    core.summary.emptyBuffer()
    delete core.summary._filePath
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbuf-action-test-'))
    fakeHome = path.join(tempDir, 'home')
    fs.mkdirSync(fakeHome, { recursive: true })
    homedirMock.mockReturnValue(fakeHome)
    userInfoMock.mockImplementation(() => ({ homedir: fakeHome }))
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
      expect.objectContaining({
        cwd: 'services/billing',
        silent: true
      })
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

  it('omits GHES token by resolving latest release via web redirect and uses --help for < v0.17.0', async () => {
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
      ok: false,
      status: 302,
      headers: {
        get: key =>
          key.toLowerCase() === 'location'
            ? '/pbufio/pbuf-registry/releases/tag/v0.16.0/?utm=1#top'
            : null
      }
    })

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/pbufio/pbuf-registry/releases/latest',
      expect.objectContaining({ redirect: 'manual' })
    )
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
    expect(execMock).toHaveBeenCalledWith(legacyBin, ['--help'])
    fetchMock.mockRestore()
  })

  it('falls back to web redirect on 403 and rejects malformed release tag', async () => {
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'latest'
      if (name === 'github_token') return 'emu_scoped_token'
      return ''
    })

    const cancelMock = jest.fn().mockResolvedValue()
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        body: { cancel: cancelMock }
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: {
          get: key =>
            key.toLowerCase() === 'location'
              ? 'https://github.com/pbufio/pbuf-registry/releases/tag/not-a-semver'
              : null
        }
      })

    await main.run()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cancelMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://github.com/pbufio/pbuf-registry/releases/latest'
    )
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid release tag "not-a-semver" returned by GitHub'
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

  it('falls back to versioned $HOME/.cache/pbuf when RUNNER_TOOL_CACHE is unset or unwritable and reuses cache', async () => {
    const readOnlyToolCache = path.join(tempDir, 'ro-tool-cache')
    fs.mkdirSync(readOnlyToolCache, { mode: 0o555 })
    process.env.RUNNER_TOOL_CACHE = readOnlyToolCache

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

    const fallbackDir = path.join(
      fakeHome,
      '.cache',
      'pbuf',
      '0.19.0',
      archName
    )
    const fallbackBin = path.join(fallbackDir, 'pbuf')
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackBin)).toBe(true)
    expect(addPathMock).toHaveBeenCalledWith(fallbackDir)

    // Reuses cached binary both when RUNNER_TOOL_CACHE is unwritable and when unset
    await main.run()
    delete process.env.RUNNER_TOOL_CACHE
    await main.run()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fs.chmodSync(readOnlyToolCache, 0o755)
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
          {
            id: 555,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: `${scopedMarker}\nold orders report`
          }
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
          {
            id: 901,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: `${main.COMMENT_MARKER}\r\nold crlf body`
          }
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

  it('emits GitHub PR file annotations for pbuf lint violations, caps inline errors at 8, and still runs drift_diff', async () => {
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
    expect(errorMock).toHaveBeenCalledTimes(8)
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
      'Annotated first 8 of 52 pbuf lint violations inline.'
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

  it.each([
    ['', true],
    ['false', false]
  ])(
    'honors job_summary=%s for lint and drift reports with real summary file and escaping',
    async (input, enabled) => {
      const summaryPath = path.join(tempDir, 'summary.md')
      fs.writeFileSync(summaryPath, '')
      process.env.GITHUB_STEP_SUMMARY = summaryPath
      const inputs = {
        version: 'v0.19.0',
        lint: 'true',
        drift_diff: 'true',
        job_summary: input
      }
      getInputMock.mockImplementation(name => inputs[name] || '')
      execMock.mockImplementation(async (cmd, args, options) => {
        if (cmd === 'pbuf' && args[0] === 'lint') {
          const manyFindings = Array.from({ length: 50 }, (_, idx) => ({
            filename: `proto/extra_${idx + 1}.proto`,
            line: 1,
            column: 1,
            rule: 'FILE_NAME',
            message: `Violation ${idx + 1}`
          }))
          options.listeners.stdout(
            Buffer.from(
              JSON.stringify({
                files: 2,
                findings: [
                  null,
                  [],
                  {
                    filename: 'proto/example.proto',
                    line: 3,
                    column: 4,
                    rule: 'FIELD_NAME',
                    message:
                      'Use first | second <script> [x](https://evil)\r\nnext'
                  },
                  ...manyFindings
                ]
              })
            )
          )
          return 1
        }
        if (cmd === 'pbuf' && args[0] === 'drift') {
          options.listeners.stdout(
            Buffer.from('### Schema Drift Diff: example\n')
          )
        }
        return 0
      })

      await main.run()
      const summary = fs.readFileSync(summaryPath, 'utf8')
      expect([
        summary.includes('### pbuf lint'),
        summary.includes('2 file(s) checked, 51 violation(s).'),
        summary.includes('proto/example.proto:3:4'),
        summary.includes(
          '| FIELD\\_NAME | Use first \\| second &lt;script&gt; \\[x\\](https://evil) next |'
        ),
        summary.includes('Showing the first 50 findings.'),
        summary.includes('### Schema Drift Diff: example')
      ]).toEqual(Array(6).fill(enabled))
      expect(summary.includes('Violation 50')).toBe(false)
      expect(setOutputMock).toHaveBeenCalledWith('lint_exit_code', '1')
      expect(setOutputMock).toHaveBeenCalledWith('drift_exit_code', '0')
    }
  )

  it('writes 0-violation lint summary and warns cleanly when GITHUB_STEP_SUMMARY write fails', async () => {
    const cleanSummaryPath = path.join(tempDir, 'clean-summary.md')
    fs.writeFileSync(cleanSummaryPath, '')
    process.env.GITHUB_STEP_SUMMARY = cleanSummaryPath
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.19.0'
      if (name === 'lint') return 'true'
      return ''
    })
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(
          Buffer.from(JSON.stringify({ files: 3, findings: [] }))
        )
      }
      return 0
    })

    await main.run()
    const cleanSummary = fs.readFileSync(cleanSummaryPath, 'utf8')
    expect(cleanSummary).toContain(
      '3 file(s) checked, 0 violation(s). Exit code: 0.'
    )
    expect(cleanSummary).not.toContain('| Location | Rule | Finding |')
    expect(setFailedMock).not.toHaveBeenCalled()

    // Now simulate an unwritable GITHUB_STEP_SUMMARY path (missing file)
    core.summary.emptyBuffer()
    delete core.summary._filePath
    process.env.GITHUB_STEP_SUMMARY = path.join(tempDir, 'missing-summary.md')

    await main.run()
    expect(core.summary.isEmptyBuffer()).toBe(true)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('Could not write job summary')
    )
    expect(setFailedMock).not.toHaveBeenCalled()
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

  it('passes --ignore-rule to pbuf lint on v0.21.0+, rejects < v0.21.0 or invalid rule tokens, and warns when lint is false', async () => {
    const v21Dir = path.join(toolCacheDir, 'pbuf', '0.21.0', archName)
    fs.mkdirSync(v21Dir, { recursive: true })
    fs.writeFileSync(path.join(v21Dir, 'pbuf'), '#!/bin/sh\n', { mode: 0o755 })

    expect(main.supportsLintIgnoreRule('0.20.9')).toBe(false)
    expect(main.supportsLintIgnoreRule('0.21.0')).toBe(true)
    expect(main.supportsLintIgnoreRule('0.21.0-rc.1')).toBe(true)
    expect(main.supportsLintIgnoreRule('1.0.0')).toBe(true)
    expect(main.parseLintIgnoreRules('  ')).toEqual([])
    expect(
      main.parseLintIgnoreRules(' file_name , ENUM_ZERO_VALUE\nfile_name ')
    ).toEqual(['FILE_NAME', 'ENUM_ZERO_VALUE'])
    expect(() => main.parseLintIgnoreRules(',')).toThrow(
      'Invalid lint_ignore_rules entry ""'
    )
    expect(() => main.parseLintIgnoreRules('FILE_NAME,')).toThrow(
      'Invalid lint_ignore_rules entry ""'
    )
    expect(() => main.parseLintIgnoreRules('--output=table')).toThrow(
      'Invalid lint_ignore_rules entry "--output=table"'
    )

    // v0.21.0 passes normalized --ignore-rule flag before -- paths
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.21.0'
        case 'lint':
          return 'true'
        case 'lint_ignore_rules':
          return 'file_name, enum_zero_value'
        case 'lint_paths':
          return 'api'
        default:
          return ''
      }
    })
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'lint') {
        options.listeners.stdout(
          Buffer.from(JSON.stringify({ files: 1, findings: [] }))
        )
      }
      return 0
    })
    await main.run()
    expect(execMock).toHaveBeenCalledWith(
      'pbuf',
      [
        'lint',
        '-o',
        'json',
        '--ignore-rule=FILE_NAME,ENUM_ZERO_VALUE',
        '--',
        'api'
      ],
      expect.anything()
    )
    expect(setFailedMock).not.toHaveBeenCalled()

    // < v0.21.0 rejects lint_ignore_rules cleanly
    setFailedMock.mockClear()
    execMock.mockClear()
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.20.0'
        case 'lint':
          return 'true'
        case 'lint_ignore_rules':
          return 'FILE_NAME'
        default:
          return ''
      }
    })
    const v20Dir = path.join(toolCacheDir, 'pbuf', '0.20.0', archName)
    fs.mkdirSync(v20Dir, { recursive: true })
    fs.writeFileSync(path.join(v20Dir, 'pbuf'), '#!/bin/sh\n', { mode: 0o755 })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'lint_ignore_rules requires pbuf CLI v0.21.0 or newer (installed v0.20.0)'
    )
    expect(execMock).not.toHaveBeenCalledWith(
      'pbuf',
      expect.arrayContaining(['lint']),
      expect.anything()
    )

    // lint_ignore_rules without lint: true logs a warning
    warningMock.mockClear()
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.21.0'
      if (name === 'lint_ignore_rules') return 'FILE_NAME'
      return ''
    })
    await main.run()
    expect(warningMock).toHaveBeenCalledWith(
      'lint_paths and lint_ignore_rules have no effect unless lint is true.'
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

    // Symlinked ~/.netrc where writeFileSync throws after unlinkSync -> post still restores symlink
    for (const key of Object.keys(savedState)) {
      delete savedState[key]
    }
    setFailedMock.mockClear()
    const writeSpy = jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device')
      })
    await main.run()
    writeSpy.mockRestore()
    expect(setFailedMock).toHaveBeenCalledWith(
      'ENOSPC: no space left on device'
    )
    expect(fs.existsSync(netrcPath)).toBe(false)
    expect(savedState.netrcMode).toBe('symlink')
    expect(savedState.netrcSymlinkTarget).toBe(dotfileNetrc)

    await main.run()
    expect(fs.lstatSync(netrcPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(netrcPath)).toBe(dotfileNetrc)
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

    const tableMarkdown = `### Schema Drift Diff: ex\r\n${'x'.repeat(59930)}\r\n${'y'.repeat(100)}`
    const truncated = main.truncateMarkdown(tableMarkdown)
    expect(truncated).toContain('_...report truncated..._')
    expect(truncated).not.toContain('yyyy')
    expect(truncated).not.toContain('\r\n\n_...report truncated..._')
    expect(truncated.length).toBeLessThanOrEqual(60000)
    expect(main.truncateMarkdown(truncated)).toBe(truncated)

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

  it('hardens container .netrc home lookup, whitespace tokens, auth stderr, CR escaping, Retry-After, and idle warnings', async () => {
    // 1. Whitespace pbuf_token and github_token rejected before install/auth
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.21.0'
      if (name === 'pbuf_token') return 'Bearer pbuf_bad'
      return ''
    })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid pbuf_token: token must not contain whitespace'
    )
    expect(execMock).not.toHaveBeenCalled()

    setFailedMock.mockClear()
    setSecretMock.mockClear()
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.21.0'
      if (name === 'github_token') return '  ghp_tok\ninjected  '
      return ''
    })
    await main.run()
    expect(setSecretMock).toHaveBeenCalledWith('ghp_tok\ninjected')
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid github_token: token must not contain whitespace'
    )
    expect(execMock).not.toHaveBeenCalled()

    // Reject SSO/proxy redirect Location on latest lookup
    setFailedMock.mockClear()
    getInputMock.mockImplementation(name =>
      name === 'version' ? 'latest' : ''
    )
    const ssoFetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: {
        get: key =>
          key.toLowerCase() === 'location'
            ? 'https://sso.corp/login?next=/pbufio/pbuf-registry/releases/tag/v0.1.0'
            : null
      }
    })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Failed to resolve latest pbuf release tag (status 302)'
    )
    ssoFetchMock.mockRestore()

    // 2. Container HOME (/github/home) vs passwd homedir (/root) + auth stderr surfacing
    jest.clearAllMocks()
    const passwdHome = path.join(tempDir, 'passwd-root')
    fs.mkdirSync(passwdHome, { recursive: true })
    userInfoMock.mockImplementation(() => ({ homedir: passwdHome }))
    const v21Dir = path.join(toolCacheDir, 'pbuf', '0.21.0', archName)
    fs.mkdirSync(v21Dir, { recursive: true })
    fs.writeFileSync(path.join(v21Dir, 'pbuf'), '#!/bin/sh\n', { mode: 0o755 })

    const savedState = {}
    saveStateMock.mockImplementation((k, v) => {
      savedState[k] = v
    })
    getStateMock.mockImplementation(k => savedState[k] || '')

    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.21.0'
      if (name === 'pbuf_token') return 'pbuf_valid_token'
      return ''
    })
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'auth') {
        options.listeners.stderr(
          Buffer.from('failed to save .netrc file: permission denied\n')
        )
        return 1
      }
      return 0
    })
    await main.run()
    expect(savedState.netrcPath).toBe(path.join(passwdHome, '.netrc'))
    expect(setFailedMock).toHaveBeenCalledWith(
      'failed to save .netrc file: permission denied'
    )

    // 3. Tokenless post-cleanup exits cleanly, and userInfo throw falls back to os.homedir()
    for (const k of Object.keys(savedState)) delete savedState[k]
    savedState.isPost = 'true'
    await main.run()

    for (const k of Object.keys(savedState)) delete savedState[k]
    userInfoMock.mockImplementation(() => {
      throw new Error('ENOENT: no passwd entry')
    })
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.21.0'
        case 'pbuf_token':
          return 'pbuf_valid_token'
        case 'lint':
          return 'true'
        case 'lint_ignore_rules':
          return '--bad'
        case 'comment_on_pr':
          return 'true'
        default:
          return ''
      }
    })
    execMock.mockResolvedValue(0)
    setFailedMock.mockClear()
    warningMock.mockClear()
    await main.run()
    expect(savedState.netrcPath).toBe(path.join(fakeHome, '.netrc'))
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid lint_ignore_rules entry "--bad"'
    )
    expect(warningMock).toHaveBeenCalledWith(
      'comment_on_pr and against have no effect unless drift_diff is true.'
    )

    // 4. Standalone \r workflow-command escaping and 60k output truncation
    for (const k of Object.keys(savedState)) delete savedState[k]
    infoMock.mockClear()
    setOutputMock.mockClear()
    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'v0.21.0'
      if (name === 'drift_diff') return 'true'
      return ''
    })
    const bigReport = `### Schema Drift Diff: ex\r::error::injected\n${'a'.repeat(60100)}`
    execMock.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'pbuf' && args[0] === 'drift') {
        options.listeners.stdout(Buffer.from(bigReport))
      }
      return 0
    })
    await main.run()
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining('\r: :error::injected')
    )
    const emittedOutput = setOutputMock.mock.calls.find(
      c => c[0] === 'drift_markdown'
    )[1]
    expect(emittedOutput).toContain('_...report truncated..._')
    expect(emittedOutput.length).toBeLessThan(60100)

    // 5. Retry-After numeric + HTTP-date (on 503) headers + non-zero delay exhaustion in fetchWithRetry
    const fixedNow = Date.parse('Wed, 20 Nov 2026 10:00:00.995 GMT')
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: k => (k === 'retry-after' ? '0.005' : null) }
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: {
          get: k =>
            k === 'retry-after' ? 'Wed, 20 Nov 2026 10:00:01 GMT' : null
        }
      })
      .mockRejectedValueOnce(new Error('final network failure'))
    await expect(
      main.fetchWithRetry('https://example.com', {}, 1000, 3, 1)
    ).rejects.toThrow('final network failure')
    nowSpy.mockRestore()
    fetchMock.mockRestore()
  })

  it('defends sticky PR comments against spoofing, skips unchanged bot body, and retries POST on 403 Retry-After', async () => {
    const eventFile = path.join(tempDir, 'spoof-event.json')
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ issue: { number: 88, pull_request: {} } })
    )
    process.env.GITHUB_EVENT_PATH = eventFile
    process.env.GITHUB_REPOSITORY = 'pbufio/example-protos'
    process.env.GITHUB_WORKSPACE = '/runner/_work/repo/repo'

    expect(
      main.buildCommentMarker('/runner/_work/repo/repo/proto/orders/')
    ).toBe('<!-- pbuf-drift-diff:proto/orders -->')
    expect(main.buildCommentMarker('proto/a/../orders')).toBe(
      '<!-- pbuf-drift-diff:proto/orders -->'
    )
    expect(main.buildCommentMarker('/tmp/runner-secret/pbuf-smoke')).toBe(
      '<!-- pbuf-drift-diff:pbuf-smoke -->'
    )

    const report =
      '### Schema Drift Diff: `acme/orders`\n\nNo breaking changes.'
    const expectedBody = `${main.COMMENT_MARKER}\n${report}`

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
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
        options.listeners.stdout(Buffer.from(`${report}\n`))
      }
      return 0
    })

    // Case 1: Attacker comment on page 1 (even with identical body or external Bot type)
    // does NOT stop pagination; genuine github-actions[bot] comment on page 2 with identical body skips PATCH.
    let fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: h =>
            h === 'link'
              ? '<https://api.github.com/repositories/1/issues/88/comments?page=2>; rel="next"'
              : null
        },
        json: async () => [
          {
            id: 1,
            user: { login: 'mallory', type: 'User' },
            body: `${main.COMMENT_MARKER}\nFake clean report`
          },
          {
            id: 2,
            user: { login: 'evil-app[bot]', type: 'Bot' },
            body: expectedBody
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            id: 3,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: expectedBody
          }
        ]
      })

    await main.run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(infoMock).toHaveBeenCalledWith(
      'Sticky drift diff comment #3 on PR #88 is already up to date'
    )
    fetchMock.mockRestore()

    // Case 2: Spoofed comment with identical body when no bot comment exists yet + deleted 404 bot comment:
    // mallory's comment is ignored without calling PATCH, deleted bot comment 404 falls back to POST,
    // exact 100 comments without rel="next" stops at 1 GET, and POST retries 403 secondary rate limit with Retry-After.
    infoMock.mockClear()
    const hundredComments = Array.from({ length: 100 }, (_, idx) => {
      if (idx === 0) {
        return {
          id: 77,
          user: { login: 'mallory', type: 'User' },
          body: expectedBody
        }
      }
      if (idx === 1) {
        return {
          id: 78,
          user: { login: 'github-actions[bot]', type: 'Bot' },
          body: `${main.COMMENT_MARKER}\nolder report`
        }
      }
      return { id: 100 + idx, user: null, body: 'unrelated' }
    })
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => hundredComments
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: { get: () => null }
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: h => (h === 'retry-after' ? '0.001' : null) }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => null },
        json: async () => ({ id: 200 })
      })

    await main.run()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[1][0]).toContain('/issues/comments/78')
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH')
    expect(fetchMock.mock.calls[2][1].method).toBe('POST')
    expect(fetchMock.mock.calls[3][1].method).toBe('POST')
    expect(infoMock).toHaveBeenCalledWith(
      'Posted sticky drift diff comment on PR #88'
    )
    fetchMock.mockRestore()
  })

  it('handles 0400 ~/.netrc, missing $HOME, missing pbuf.yaml warning, and release download/API error branches', async () => {
    // 1. Missing $HOME directory + missing pbuf.yaml warning, then read-only 0400 ~/.netrc + existing pbuf.yaml
    const missingHome = path.join(tempDir, 'nonexistent-home')
    userInfoMock.mockImplementation(() => ({ homedir: missingHome }))
    homedirMock.mockReturnValue(missingHome)

    const savedState = {}
    saveStateMock.mockImplementation((k, v) => {
      savedState[k] = v
    })
    getStateMock.mockImplementation(k => savedState[k] || '')

    const workDir = path.join(tempDir, 'svc-dir')
    fs.mkdirSync(workDir, { recursive: true })

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'version':
          return 'v0.19.0'
        case 'pbuf_token':
          return 'pbuf_secret_tok'
        case 'working_directory':
          return workDir
        default:
          return ''
      }
    })

    await main.run()
    expect(fs.existsSync(missingHome)).toBe(true)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'No registry_url, PBUF_REGISTRY_ADDR, or pbuf.yaml found'
      )
    )

    // Create 0400 read-only ~/.netrc and a pbuf.yaml -> rewrites as 0600 writable and emits no missing-pbuf.yaml warning
    for (const k of Object.keys(savedState)) delete savedState[k]
    warningMock.mockClear()
    const netrcPath = path.join(missingHome, '.netrc')
    fs.writeFileSync(netrcPath, 'machine example.com login u password p\n', {
      mode: 0o400
    })
    fs.writeFileSync(path.join(workDir, 'pbuf.yaml'), 'name: acme/svc\n')

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
    expect(setFailedMock).not.toHaveBeenCalled()
    expect(warningMock).not.toHaveBeenCalled()
    await main.run()
    expect(fs.readFileSync(netrcPath, 'utf8')).toBe(
      'machine example.com login u password p\n'
    )

    // 2. Release API malformed tag_name, API 500, checksums 404, and archive 404
    getStateMock.mockReturnValue('')
    fs.rmSync(toolCacheDir, { recursive: true, force: true })

    getInputMock.mockImplementation(name => {
      if (name === 'version') return 'latest'
      if (name === 'github_token') return 'ghs_tok'
      return ''
    })
    let fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'bad-tag' })
    })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid release tag "bad-tag" returned by GitHub API'
    )
    fetchMock.mockRestore()

    setFailedMock.mockClear()
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null }
    })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Failed to resolve latest pbuf release tag (status 500)'
    )
    fetchMock.mockRestore()

    setFailedMock.mockClear()
    getInputMock.mockImplementation(name =>
      name === 'version' ? 'v0.19.0' : ''
    )
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('x')
      })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Failed to download checksums.txt for v0.19.0 (status 404)'
    )
    fetchMock.mockRestore()

    setFailedMock.mockClear()
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 404 })
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith(
      `Failed to download pbuf_0.19.0_${osName}_${archName}.tar.gz (status 404)`
    )
    fetchMock.mockRestore()
  })
})
