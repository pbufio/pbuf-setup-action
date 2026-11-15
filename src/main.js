const fs = require('fs')
const net = require('net')
const core = require('@actions/core')
const io = require('@actions/io')
const exec = require('@actions/exec')

const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/pbufio/pbuf-registry/main/scripts/install.sh'
const VERSION_RE = /^(latest|v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/
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

async function runDriftDiff(workingDirectory) {
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
  const githubToken =
    core.getInput('github_token') || process.env.GITHUB_TOKEN || ''
  if (githubToken !== '') {
    core.setSecret(githubToken)
  }

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

    core.info(`Installing pbuf cli version ${version}`)

    if (pbufToken === '') {
      core.info('No pbuf_token provided, skipping login')
    }

    if (version === 'latest') {
      await exec.exec('/bin/bash', [
        '-lc',
        `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`
      ])
    } else {
      await exec.exec('/bin/bash', [
        '-lc',
        `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- -v "$1"`,
        '_',
        version
      ])
    }

    await io.which('pbuf', true)

    if (pbufToken !== '') {
      core.info('Authenticate into the pbuf registry')
      await exec.exec('pbuf', ['auth', '--', pbufToken], {
        cwd: workingDirectory || undefined,
        silent: true
      })
    }

    core.info('Successfully setup pbuf cli')

    if (core.getInput('drift_diff').trim().toLowerCase() === 'true') {
      await runDriftDiff(workingDirectory)
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
  run
}
