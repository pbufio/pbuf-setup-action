const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const core = require('@actions/core')
const exec = require('@actions/exec')

const RELEASE_API_URL =
  'https://api.github.com/repos/pbufio/pbuf-registry/releases/latest'
const RELEASE_DOWNLOAD_BASE =
  'https://github.com/pbufio/pbuf-registry/releases/download'
const VERSION_RE = /^(latest|v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const HOSTNAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const VALID_FAIL_ON = new Set(['critical', 'warning', 'info', 'none'])
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMENT_MARKER = '<!-- pbuf-drift-diff -->'
const MAX_COMMENT_CHARS = 60000
const MAX_COMMENT_PAGES = 25
const MAX_LINT_ANNOTATIONS = 50
const DEFAULT_RETRY_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 250
const CLI_FATAL_TRAILER_RE =
  /(?:^|\r?\n)(?:\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?failed to execute command:\s*([\s\S]*)$/
const CLI_FATAL_PREFIX_RE =
  /^(?:\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?failed to execute command:\s*/

function normalizeRegistryAddr(raw) {
  const stripped = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')

  let host = ''
  let port = ''
  if (stripped.startsWith('[')) {
    const match = stripped.match(/^\[([^\]]+)\](?::([1-9]\d{0,4}))?$/)
    if (!match || net.isIP(match[1]) !== 6) {
      throw new Error(`Invalid registry_url "${raw}" (expected host[:port])`)
    }
    host = match[1]
    port = match[2] || ''
  } else if (net.isIP(stripped) === 6) {
    host = stripped
  } else {
    const match = stripped.match(/^([^:]+)(?::([1-9]\d{0,4}))?$/)
    if (
      !match ||
      (net.isIP(match[1]) !== 4 &&
        (match[1].length > 253 || !HOSTNAME_RE.test(match[1])))
    ) {
      throw new Error(`Invalid registry_url "${raw}" (expected host[:port])`)
    }
    host = match[1]
    port = match[2] || ''
  }

  if (port !== '') {
    const portNum = Number(port)
    if (portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid registry_url "${raw}" (expected host[:port])`)
    }
    return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
  }

  return host
}

function buildCommentMarker(workingDirectory = '') {
  const normalized = workingDirectory
    .trim()
    .replace(/[\r\n<>]/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/$/, '')
  if (normalized === '' || normalized === '.') {
    return COMMENT_MARKER
  }
  return `<!-- pbuf-drift-diff:${normalized} -->`
}

function parseDriftCliOutput(rawStdout, rawStderr, exitCode) {
  const fatalMatch = rawStdout.match(CLI_FATAL_TRAILER_RE)
  const fatalMessage = fatalMatch ? fatalMatch[1].trim() : ''
  let cleanedStdout = (
    fatalMatch ? rawStdout.slice(0, fatalMatch.index) : rawStdout
  ).trim()
  let cleanedStderr = rawStderr
    .replace(/(?:^|\r?\n)Usage:\r?\n[\s\S]*$/, '')
    .trim()
    .replace(CLI_FATAL_PREFIX_RE, '')
    .trim()

  if (exitCode !== 0 && cleanedStdout !== '') {
    const isDriftMarkdown =
      cleanedStdout.startsWith('### Schema Drift Diff:') ||
      cleanedStdout.startsWith('No prior published tags found for ')
    if (!isDriftMarkdown) {
      if (!cleanedStderr) {
        cleanedStderr = cleanedStdout
      }
      cleanedStdout = ''
    }
  }

  if (!cleanedStderr && fatalMessage) {
    cleanedStderr = fatalMessage
  }

  return { markdown: cleanedStdout, errorMessage: cleanedStderr }
}

function parseBooleanInput(name, defaultValue = false) {
  const raw = core.getInput(name).trim()
  const normalized = raw.toLowerCase()
  if (normalized === '') {
    return defaultValue
  }
  if (normalized === 'false') {
    return false
  }
  if (normalized === 'true') {
    return true
  }
  throw new Error(
    `Invalid boolean input ${name}="${raw}" (expected true or false)`
  )
}

async function fetchWithRetry(
  url,
  options = {},
  timeoutMs = 15000,
  attempts = 3,
  baseDelayMs = DEFAULT_RETRY_DELAY_MS,
  readBody = null
) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (attempt < attempts && (res.status === 429 || res.status >= 500)) {
        if (res.body && typeof res.body.cancel === 'function') {
          try {
            await res.body.cancel()
          } catch {
            // ignore body cancel errors before retry
          }
        }
      } else {
        const bodyData =
          res.ok && typeof readBody === 'function'
            ? await readBody(res)
            : undefined
        return readBody ? { res, bodyData } : res
      }
    } catch (error) {
      lastError = error
      if (attempt >= attempts) {
        throw error
      }
    }
    if (baseDelayMs > 0) {
      await new Promise(resolve =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1))
      )
    }
  }
  throw lastError
}

function truncateMarkdown(markdown) {
  if (markdown.length <= MAX_COMMENT_CHARS) {
    return markdown
  }
  const lastNewline = markdown.lastIndexOf('\n', MAX_COMMENT_CHARS)
  const cutIndex =
    lastNewline >= MAX_COMMENT_CHARS - 2000 ? lastNewline : MAX_COMMENT_CHARS
  const prefix = markdown.slice(0, cutIndex)
  const safePrefix =
    typeof prefix.toWellFormed === 'function' ? prefix.toWellFormed() : prefix
  return `${safePrefix}\n\n_...report truncated..._`
}

function getPullRequestNumber() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) {
    return null
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
  const candidate =
    event.pull_request && event.pull_request.number
      ? event.pull_request.number
      : event.issue && event.issue.pull_request && event.issue.number
        ? event.issue.number
        : null
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null
}

async function upsertPullRequestComment(
  markdown,
  githubToken,
  workingDirectory = ''
) {
  try {
    const prNumber = getPullRequestNumber()
    if (!prNumber) {
      core.info('Skipping PR comment: workflow event is not a pull request')
      return
    }

    const repository = process.env.GITHUB_REPOSITORY || ''
    if (!REPO_RE.test(repository)) {
      core.warning('Skipping PR comment: valid GITHUB_REPOSITORY is not set')
      return
    }

    if (!githubToken) {
      core.warning('Skipping PR comment: github_token is not provided')
      return
    }

    const marker = buildCommentMarker(workingDirectory)
    const truncated = truncateMarkdown(markdown)
    const body = `${marker}\n${truncated}`
    const apiBase = (
      process.env.GITHUB_API_URL || 'https://api.github.com'
    ).replace(/\/+$/, '')
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pbuf-setup-action',
      'X-GitHub-Api-Version': '2022-11-28'
    }

    let existingId = null
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const listUrl = `${apiBase}/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`
      const listRes = await fetchWithRetry(
        listUrl,
        {
          method: 'GET',
          headers
        },
        10000
      )
      if (!listRes.ok) {
        throw new Error(`GET comments failed with status ${listRes.status}`)
      }
      const comments = await listRes.json()
      const found = comments.find(comment => {
        if (!comment || typeof comment.body !== 'string') {
          return false
        }
        const trimmedBody = comment.body.replace(/\r\n/g, '\n').trimStart()
        return trimmedBody === marker || trimmedBody.startsWith(`${marker}\n`)
      })
      if (found) {
        existingId = found.id
        break
      }
      const linkHeader =
        listRes.headers && typeof listRes.headers.get === 'function'
          ? listRes.headers.get('link') || ''
          : ''
      if (!linkHeader.includes('rel="next"') && comments.length < 100) {
        break
      }
    }

    if (existingId) {
      const patchUrl = `${apiBase}/repos/${repository}/issues/comments/${existingId}`
      const patchRes = await fetchWithRetry(
        patchUrl,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body })
        },
        10000
      )
      if (!patchRes.ok) {
        throw new Error(`PATCH comment failed with status ${patchRes.status}`)
      }
      core.info(
        `Updated sticky drift diff comment #${existingId} on PR #${prNumber}`
      )
      return
    }

    const createUrl = `${apiBase}/repos/${repository}/issues/${prNumber}/comments`
    const createRes = await fetchWithRetry(
      createUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ body })
      },
      10000,
      1
    )
    if (!createRes.ok) {
      throw new Error(`POST comment failed with status ${createRes.status}`)
    }
    core.info(`Posted sticky drift diff comment on PR #${prNumber}`)
  } catch (error) {
    core.warning(
      `Could not post PR comment (${error.message}). Ensure pull-requests: write permission is granted.`
    )
  }
}

function resolvePlatform(platform = process.platform, arch = process.arch) {
  let osName = ''
  if (platform === 'linux') {
    osName = 'linux'
  } else if (platform === 'darwin') {
    osName = 'darwin'
  } else {
    throw new Error(`Unsupported operating system "${platform}"`)
  }

  let archName = ''
  if (arch === 'x64') {
    archName = 'amd64'
  } else if (arch === 'arm64') {
    archName = 'arm64'
  } else {
    throw new Error(`Unsupported architecture "${arch}"`)
  }

  return { osName, archName }
}

async function resolveReleaseTag(version, githubToken) {
  if (version !== 'latest') {
    return version.startsWith('v') ? version : `v${version}`
  }

  const baseHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pbuf-setup-action',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const configuredApi = (
    process.env.GITHUB_API_URL || 'https://api.github.com'
  ).replace(/\/+$/, '')
  const useAuth =
    githubToken !== '' && configuredApi === 'https://api.github.com'

  let res = await fetchWithRetry(
    RELEASE_API_URL,
    {
      method: 'GET',
      headers: useAuth
        ? { ...baseHeaders, Authorization: `Bearer ${githubToken}` }
        : baseHeaders
    },
    15000
  )
  if ((res.status === 401 || res.status === 403) && useAuth) {
    res = await fetchWithRetry(
      RELEASE_API_URL,
      {
        method: 'GET',
        headers: baseHeaders
      },
      15000
    )
  }
  if (!res.ok) {
    throw new Error(
      `Failed to resolve latest pbuf release tag (status ${res.status})`
    )
  }

  const data = await res.json()
  const tagName = typeof data.tag_name === 'string' ? data.tag_name.trim() : ''
  if (!RELEASE_TAG_RE.test(tagName)) {
    throw new Error(`Invalid release tag "${tagName}" returned by GitHub API`)
  }
  return tagName
}

function parseExpectedChecksum(checksumsText, archiveName) {
  for (const line of checksumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/)
    if (match && match[2] === archiveName) {
      return match[1].toLowerCase()
    }
  }
  throw new Error(
    `Checksum entry for ${archiveName} not found in checksums.txt`
  )
}

function smokeCheckArg(plainVersion) {
  const [major, minor] = plainVersion.split('.', 2).map(Number)
  return major === 0 && minor < 17 ? '--help' : '--version'
}

function supportsLint(plainVersion) {
  const [major, minor] = plainVersion.split('.', 2).map(Number)
  return major > 0 || minor >= 19
}

function parseLintPaths(raw) {
  const paths = []
  let current = ''
  let quote = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quote !== '') {
      if (ch === quote) {
        quote = ''
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current !== '') {
        paths.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (quote !== '') {
    throw new Error('Unclosed quote in lint_paths')
  }
  if (current !== '') {
    paths.push(current)
  }
  return paths
}

function resolveAnnotationFile(filename, workingDirectory = '') {
  if (typeof filename !== 'string' || filename.trim() === '') {
    return undefined
  }
  const workspace = (process.env.GITHUB_WORKSPACE || '').trim()
  const rootDir = workspace ? path.resolve(workspace) : process.cwd()
  const baseDir = workingDirectory
    ? path.resolve(rootDir, workingDirectory)
    : rootDir
  const absFile = path.isAbsolute(filename)
    ? path.normalize(filename)
    : path.resolve(baseDir, filename)
  const rel = path.relative(rootDir, absFile).replace(/\\/g, '/')
  if (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('../') &&
    !path.isAbsolute(rel)
  ) {
    return rel
  }
  return absFile.replace(/\\/g, '/')
}

async function installPbufCli(version, githubToken) {
  const { osName, archName } = resolvePlatform()
  const tag = await resolveReleaseTag(version, githubToken)
  const plainVersion = tag.slice(1)
  const toolCacheRoot = (process.env.RUNNER_TOOL_CACHE || '').trim()
  const installDir = toolCacheRoot
    ? path.join(toolCacheRoot, 'pbuf', plainVersion, archName)
    : path.join(os.homedir(), '.local', 'bin')
  const destBin = path.join(installDir, 'pbuf')

  if (
    toolCacheRoot &&
    fs.existsSync(destBin) &&
    fs.lstatSync(destBin).isFile()
  ) {
    core.info(`Reusing cached pbuf ${tag} from ${installDir}`)
  } else {
    const archiveName = `pbuf_${plainVersion}_${osName}_${archName}.tar.gz`
    const checksumsUrl = `${RELEASE_DOWNLOAD_BASE}/${tag}/checksums.txt`
    const archiveUrl = `${RELEASE_DOWNLOAD_BASE}/${tag}/${archiveName}`

    core.info(`Downloading ${archiveName} (${tag}) and verifying SHA-256...`)
    const [checksumsDownload, archiveDownload] = await Promise.all([
      fetchWithRetry(checksumsUrl, {}, 30000, 3, DEFAULT_RETRY_DELAY_MS, res =>
        res.text()
      ),
      fetchWithRetry(archiveUrl, {}, 60000, 3, DEFAULT_RETRY_DELAY_MS, res =>
        res.arrayBuffer()
      )
    ])
    const { res: checksumsRes, bodyData: checksumsText } = checksumsDownload
    const { res: archiveRes, bodyData: archiveArrayBuffer } = archiveDownload
    if (!checksumsRes.ok) {
      throw new Error(
        `Failed to download checksums.txt for ${tag} (status ${checksumsRes.status})`
      )
    }
    if (!archiveRes.ok) {
      throw new Error(
        `Failed to download ${archiveName} (status ${archiveRes.status})`
      )
    }

    const expectedHash = parseExpectedChecksum(checksumsText, archiveName)
    const archiveBuffer = Buffer.from(archiveArrayBuffer)
    const actualHash = crypto
      .createHash('sha256')
      .update(archiveBuffer)
      .digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA-256 checksum mismatch for ${archiveName}: expected ${expectedHash}, got ${actualHash}`
      )
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbuf-cli-'))
    let stagedBin = ''
    try {
      const archivePath = path.join(tmpDir, archiveName)
      fs.writeFileSync(archivePath, archiveBuffer)
      await exec.exec('tar', ['-xzof', archivePath, '-C', tmpDir, 'pbuf'])

      const extractedBin = path.join(tmpDir, 'pbuf')
      if (
        !fs.existsSync(extractedBin) ||
        !fs.lstatSync(extractedBin).isFile()
      ) {
        throw new Error(`Regular pbuf binary not found in ${archiveName}`)
      }

      fs.mkdirSync(installDir, { recursive: true })
      stagedBin = path.join(
        installDir,
        `.pbuf.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
      )
      fs.copyFileSync(extractedBin, stagedBin)
      fs.chmodSync(stagedBin, 0o755)
      fs.renameSync(stagedBin, destBin)
      stagedBin = ''
    } finally {
      if (stagedBin) {
        fs.rmSync(stagedBin, { force: true })
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  core.addPath(installDir)
  await exec.exec(destBin, [smokeCheckArg(plainVersion)])
  return plainVersion
}

async function execPbuf(args, workingDirectory = '') {
  const stdoutChunks = []
  const stderrChunks = []
  const exitCode = await exec.exec('pbuf', args, {
    cwd: workingDirectory || undefined,
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: data => {
        stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      },
      stderr: data => {
        stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      }
    }
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8')
  }
}

function backupNetrcBeforeAuth() {
  const netrcPath = path.join(os.homedir(), '.netrc')
  const stat = fs.lstatSync(netrcPath, { throwIfNoEntry: false })
  if (stat && stat.isSymbolicLink()) {
    const target = fs.readlinkSync(netrcPath)
    let existingBytes = null
    if (fs.existsSync(netrcPath) && fs.statSync(netrcPath).isFile()) {
      existingBytes = fs.readFileSync(netrcPath)
    }
    fs.unlinkSync(netrcPath)
    if (existingBytes !== null) {
      fs.writeFileSync(netrcPath, existingBytes, { mode: 0o600, flag: 'wx' })
    }
    core.saveState('netrcMode', 'symlink')
    core.saveState('netrcSymlinkTarget', target)
  } else if (stat && stat.isFile()) {
    const tempRoot = (process.env.RUNNER_TEMP || '').trim() || os.tmpdir()
    fs.mkdirSync(tempRoot, { recursive: true })
    const backupPath = path.join(
      tempRoot,
      `.pbuf-netrc-backup.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
    )
    fs.writeFileSync(backupPath, fs.readFileSync(netrcPath), {
      mode: 0o600,
      flag: 'wx'
    })
    core.saveState('netrcMode', 'restore')
    core.saveState('netrcBackupPath', backupPath)
  } else {
    core.saveState('netrcMode', 'delete')
  }
}

function cleanupPost() {
  const mode = core.getState('netrcMode')
  if (!mode) {
    return
  }
  const netrcPath = path.join(os.homedir(), '.netrc')
  const backupPath = core.getState('netrcBackupPath')
  const symlinkTarget = core.getState('netrcSymlinkTarget')
  let staged = ''
  try {
    const suffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`
    if (mode === 'symlink' && symlinkTarget) {
      staged = `${netrcPath}.restore.${suffix}`
      fs.symlinkSync(symlinkTarget, staged)
      fs.renameSync(staged, netrcPath)
      staged = ''
      core.info('Restored pre-existing ~/.netrc symlink after job')
    } else if (mode === 'restore' && backupPath && fs.existsSync(backupPath)) {
      staged = `${netrcPath}.restore.${suffix}`
      fs.writeFileSync(staged, fs.readFileSync(backupPath), {
        mode: 0o600,
        flag: 'wx'
      })
      fs.renameSync(staged, netrcPath)
      staged = ''
      core.info('Restored pre-existing ~/.netrc after job')
    } else if (mode === 'delete' || mode === 'restore' || mode === 'symlink') {
      fs.rmSync(netrcPath, { force: true })
      core.info('Removed temporary ~/.netrc credentials')
    }
  } catch (error) {
    core.warning(
      `Failed to clean up ~/.netrc (${error instanceof Error ? error.message : String(error)})`
    )
  } finally {
    if (staged) {
      fs.rmSync(staged, { force: true })
    }
    if (backupPath) {
      fs.rmSync(backupPath, { force: true })
    }
  }
}

function escapeSummaryCell(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\|*_\x60[\]]/g, '\\$&')
    .replace(/\r\n|\r|\n/g, ' ')
}

async function writeJobSummary(markdown) {
  try {
    await core.summary.addRaw(markdown).addEOL().addEOL().write()
  } catch (error) {
    core.summary.emptyBuffer()
    const detail = error instanceof Error ? error.message : String(error)
    core.warning(`Could not write job summary (${detail}).`)
  }
}

async function runLint(workingDirectory, plainVersion, summaryEnabled) {
  if (!supportsLint(plainVersion)) {
    core.setFailed(
      `pbuf lint requires pbuf CLI v0.19.0 or newer (installed v${plainVersion})`
    )
    return
  }

  let paths
  try {
    paths = parseLintPaths(core.getInput('lint_paths'))
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
    return
  }
  const args =
    paths.length > 0
      ? ['lint', '-o', 'json', '--', ...paths]
      : ['lint', '-o', 'json']

  const { exitCode, stdout, stderr } = await execPbuf(args, workingDirectory)

  core.setOutput('lint_exit_code', String(exitCode))

  const fatalMatch = stdout.match(CLI_FATAL_TRAILER_RE)
  const jsonCandidate = (
    fatalMatch ? stdout.slice(0, fatalMatch.index) : stdout
  ).trim()

  let report = null
  if (jsonCandidate !== '') {
    try {
      const parsed = JSON.parse(jsonCandidate)
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.findings)
      ) {
        report = parsed
      }
    } catch {
      report = null
    }
  }

  if (!report) {
    const { errorMessage } = parseDriftCliOutput(stdout, stderr, exitCode || 1)
    core.setFailed(
      errorMessage || `pbuf lint failed with exit code ${exitCode}`
    )
    return
  }

  const findings = report.findings.filter(
    f => f && typeof f === 'object' && !Array.isArray(f)
  )
  const filesCount = Number.isInteger(report.files) ? report.files : 0
  const summaryRows = []

  for (const finding of findings.slice(0, MAX_LINT_ANNOTATIONS)) {
    const rule = typeof finding.rule === 'string' ? finding.rule.trim() : ''
    const props = {
      title: rule ? `pbuf lint (${rule})` : 'pbuf lint'
    }
    const file = resolveAnnotationFile(finding.filename, workingDirectory)
    if (file) {
      props.file = file
    }
    if (Number.isInteger(finding.line) && finding.line > 0) {
      props.startLine = finding.line
    }
    if (Number.isInteger(finding.column) && finding.column > 0) {
      props.startColumn = finding.column
    }
    const prefix = rule ? `[${rule}] ` : ''
    const message =
      typeof finding.message === 'string' && finding.message.trim() !== ''
        ? finding.message.trim()
        : 'Proto lint violation'
    core.error(`${prefix}${message}`, props)
    if (summaryEnabled) {
      const location = [file, props.startLine, props.startColumn]
        .filter(Boolean)
        .join(':')
      const cells = [location || '—', rule || '—', message].map(
        escapeSummaryCell
      )
      summaryRows.push(`| ${cells.join(' | ')} |`)
    }
  }

  if (summaryEnabled) {
    const summary = [
      '### pbuf lint',
      '',
      `${filesCount} file(s) checked, ${findings.length} violation(s). Exit code: ${exitCode}.`
    ]
    if (summaryRows.length > 0) {
      summary.push('', '| Location | Rule | Finding |', '| --- | --- | --- |')
      summary.push(...summaryRows)
    }
    if (findings.length > MAX_LINT_ANNOTATIONS) {
      summary.push('', `Showing the first ${MAX_LINT_ANNOTATIONS} findings.`)
    }
    await writeJobSummary(summary.join('\n'))
  }
  if (exitCode === 0 && findings.length === 0) {
    core.info(`pbuf lint passed (${filesCount} file(s) checked, 0 violations).`)
    return
  }

  if (findings.length > MAX_LINT_ANNOTATIONS) {
    core.warning(
      `Showing first ${MAX_LINT_ANNOTATIONS} of ${findings.length} pbuf lint violations.`
    )
  }

  if (findings.length > 0) {
    core.setFailed(
      `pbuf lint failed: ${findings.length} violation(s) found across ${filesCount} file(s)`
    )
    return
  }

  const { errorMessage } = parseDriftCliOutput('', stderr, exitCode)
  core.setFailed(errorMessage || `pbuf lint failed with exit code ${exitCode}`)
}

async function runDriftDiff(
  workingDirectory,
  githubToken,
  commentOnPr,
  summaryEnabled
) {
  const failOn = (core.getInput('fail_on').trim() || 'critical').toLowerCase()
  if (!VALID_FAIL_ON.has(failOn)) {
    core.setFailed(
      `Invalid fail_on "${failOn}" (must be critical, warning, info, or none)`
    )
    return
  }

  const against = core.getInput('against').trim()

  const args = ['drift', 'diff', '--format=markdown', `--fail-on=${failOn}`]
  if (against !== '') {
    args.push(`--against=${against}`)
  }

  const { exitCode, stdout, stderr } = await execPbuf(args, workingDirectory)

  const { markdown, errorMessage } = parseDriftCliOutput(
    stdout,
    stderr,
    exitCode
  )
  core.setOutput('drift_markdown', markdown)
  core.setOutput('drift_exit_code', String(exitCode))

  if (exitCode !== 0 && markdown === '') {
    core.setFailed(
      errorMessage || `pbuf drift diff failed with exit code ${exitCode}`
    )
    return
  }

  core.info(`pbuf drift diff completed (exit code ${exitCode}).`)
  if (markdown !== '') {
    core.info(markdown.replace(/(^|\r?\n)(\s*)::/g, '$1$2: :'))
  }

  if (markdown !== '' && summaryEnabled) {
    await writeJobSummary(markdown)
  }

  if (commentOnPr && markdown !== '') {
    await upsertPullRequestComment(markdown, githubToken, workingDirectory)
  }

  if (exitCode !== 0) {
    core.setFailed(
      errorMessage || `Schema drift check failed (fail_on=${failOn})`
    )
  }
}

async function run() {
  try {
    if (core.getState('isPost') === 'true') {
      cleanupPost()
      return
    }
    core.saveState('isPost', 'true')

    const version = core.getInput('version').trim()
    const pbufToken = core.getInput('pbuf_token')
    const registryUrl = core.getInput('registry_url').trim()
    const registryInsecure = parseBooleanInput('registry_insecure')
    const lintEnabled = parseBooleanInput('lint')
    const driftDiffEnabled = parseBooleanInput('drift_diff')
    const commentOnPr = parseBooleanInput('comment_on_pr')
    const summaryEnabled =
      parseBooleanInput('job_summary', true) &&
      Boolean(process.env.GITHUB_STEP_SUMMARY)
    const workingDirectory = core.getInput('working_directory').trim()
    const githubToken =
      core.getInput('github_token') || process.env.GITHUB_TOKEN || ''

    if (version === '') {
      core.setFailed('You must provide a version')
      return
    }
    if (!VERSION_RE.test(version)) {
      core.setFailed(`Invalid version "${version}"`)
      return
    }

    if (registryUrl !== '') {
      const addr = normalizeRegistryAddr(registryUrl)
      core.exportVariable('PBUF_REGISTRY_ADDR', addr)
    }
    if (registryInsecure) {
      if (registryUrl === '' && !process.env.PBUF_REGISTRY_ADDR) {
        core.warning(
          'registry_insecure has no effect in pbuf CLI unless registry_url (or PBUF_REGISTRY_ADDR) is set; set registry.insecure: true in pbuf.yaml otherwise.'
        )
      }
      core.exportVariable('PBUF_REGISTRY_INSECURE', 'true')
    }

    if (pbufToken !== '') {
      core.setSecret(pbufToken)
    }
    if (githubToken !== '') {
      core.setSecret(githubToken)
    }

    core.info(`Installing pbuf cli version ${version}`)

    if (pbufToken === '') {
      core.info('No pbuf_token provided, skipping login')
    }

    const plainVersion = await installPbufCli(version, githubToken)

    if (pbufToken !== '') {
      core.info('Authenticate into the pbuf registry')
      backupNetrcBeforeAuth()
      await exec.exec('pbuf', ['auth', '--', pbufToken], {
        cwd: workingDirectory || undefined,
        silent: true
      })
    }

    core.info('Successfully setup pbuf cli')

    if (lintEnabled) {
      await runLint(workingDirectory, plainVersion, summaryEnabled)
    }

    if (driftDiffEnabled) {
      await runDriftDiff(
        workingDirectory,
        githubToken,
        commentOnPr,
        summaryEnabled
      )
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

module.exports = {
  COMMENT_MARKER,
  buildCommentMarker,
  fetchWithRetry,
  normalizeRegistryAddr,
  parseBooleanInput,
  parseDriftCliOutput,
  parseExpectedChecksum,
  parseLintPaths,
  resolveAnnotationFile,
  resolvePlatform,
  run,
  supportsLint,
  truncateMarkdown
}
