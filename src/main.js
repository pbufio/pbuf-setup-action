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
const CLI_FATAL_TRAILER_RE =
  /(?:^|\r?\n)(?:\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?failed to execute command:\s*([\s\S]*)$/

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

function getPullRequestNumber() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) {
    return null
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
  if (event.pull_request && event.pull_request.number) {
    return event.pull_request.number
  }
  if (event.issue && event.issue.pull_request && event.issue.number) {
    return event.issue.number
  }
  return null
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
    const truncated =
      markdown.length > MAX_COMMENT_CHARS
        ? `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n_...report truncated..._`
        : markdown
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
    for (let page = 1; page <= 5; page += 1) {
      const listUrl = `${apiBase}/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`
      const listRes = await fetch(listUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000)
      })
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
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(10000)
      })
      if (!patchRes.ok) {
        throw new Error(`PATCH comment failed with status ${patchRes.status}`)
      }
      core.info(
        `Updated sticky drift diff comment #${existingId} on PR #${prNumber}`
      )
      return
    }

    const createUrl = `${apiBase}/repos/${repository}/issues/${prNumber}/comments`
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10000)
    })
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

  let res = await fetch(RELEASE_API_URL, {
    method: 'GET',
    headers: useAuth
      ? { ...baseHeaders, Authorization: `Bearer ${githubToken}` }
      : baseHeaders,
    signal: AbortSignal.timeout(15000)
  })
  if ((res.status === 401 || res.status === 403) && useAuth) {
    res = await fetch(RELEASE_API_URL, {
      method: 'GET',
      headers: baseHeaders,
      signal: AbortSignal.timeout(15000)
    })
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
    const [checksumsRes, archiveRes] = await Promise.all([
      fetch(checksumsUrl, { signal: AbortSignal.timeout(30000) }),
      fetch(archiveUrl, { signal: AbortSignal.timeout(60000) })
    ])
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

    const checksumsText = await checksumsRes.text()
    const expectedHash = parseExpectedChecksum(checksumsText, archiveName)
    const archiveBuffer = Buffer.from(await archiveRes.arrayBuffer())
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
}

async function runDriftDiff(workingDirectory, githubToken) {
  const failOn = (core.getInput('fail_on').trim() || 'critical').toLowerCase()
  if (!VALID_FAIL_ON.has(failOn)) {
    core.setFailed(
      `Invalid fail_on "${failOn}" (must be critical, warning, info, or none)`
    )
    return
  }

  const against = core.getInput('against').trim()
  const commentOnPr =
    core.getInput('comment_on_pr').trim().toLowerCase() === 'true'

  const args = ['drift', 'diff', '--format=markdown', `--fail-on=${failOn}`]
  if (against !== '') {
    args.push(`--against=${against}`)
  }

  let stdout = ''
  let stderr = ''
  const exitCode = await exec.exec('pbuf', args, {
    cwd: workingDirectory || undefined,
    ignoreReturnCode: true,
    listeners: {
      stdout: data => {
        stdout += data.toString()
      },
      stderr: data => {
        stderr += data.toString()
      }
    }
  })

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

  if (markdown !== '' && process.env.GITHUB_STEP_SUMMARY) {
    await core.summary.addRaw(markdown).addEOL().write()
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
    const version = core.getInput('version').trim()
    const pbufToken = core.getInput('pbuf_token')
    const registryUrl = core.getInput('registry_url').trim()
    const registryInsecure =
      core.getInput('registry_insecure').trim().toLowerCase() === 'true'
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

    await installPbufCli(version, githubToken)

    if (pbufToken !== '') {
      core.info('Authenticate into the pbuf registry')
      await exec.exec('pbuf', ['auth', '--', pbufToken], {
        cwd: workingDirectory || undefined,
        silent: true
      })
    }

    core.info('Successfully setup pbuf cli')

    if (core.getInput('drift_diff').trim().toLowerCase() === 'true') {
      await runDriftDiff(workingDirectory, githubToken)
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

module.exports = {
  COMMENT_MARKER,
  buildCommentMarker,
  normalizeRegistryAddr,
  parseDriftCliOutput,
  parseExpectedChecksum,
  resolvePlatform,
  run
}
