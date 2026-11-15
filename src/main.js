const fs = require('fs')
const core = require('@actions/core')
const io = require('@actions/io')
const exec = require('@actions/exec')

const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/pbufio/pbuf-registry/main/scripts/install.sh'
const VERSION_RE = /^(latest|v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/
const VALID_FAIL_ON = new Set(['critical', 'warning', 'info', 'none'])
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMENT_MARKER = '<!-- pbuf-drift-diff -->'
const MAX_COMMENT_CHARS = 60000

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

async function upsertPullRequestComment(markdown, githubToken) {
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

    const truncated =
      markdown.length > MAX_COMMENT_CHARS
        ? `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n_...report truncated..._`
        : markdown
    const body = `${COMMENT_MARKER}\n${truncated}`
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
      const found = comments.find(
        comment =>
          typeof comment.body === 'string' &&
          comment.body.includes(COMMENT_MARKER)
      )
      if (found) {
        existingId = found.id
        break
      }
      if (comments.length < 100) {
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

async function runDriftDiff() {
  const failOn = (core.getInput('fail_on').trim() || 'critical').toLowerCase()
  if (!VALID_FAIL_ON.has(failOn)) {
    core.setFailed(
      `Invalid fail_on "${failOn}" (must be critical, warning, info, or none)`
    )
    return
  }

  const against = core.getInput('against').trim()
  const workingDirectory = core.getInput('working_directory').trim()
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

  const markdown = stdout.trim()
  core.setOutput('drift_markdown', markdown)
  core.setOutput('drift_exit_code', String(exitCode))

  if (exitCode !== 0 && markdown === '') {
    core.setFailed(
      stderr.trim() || `pbuf drift diff failed with exit code ${exitCode}`
    )
    return
  }

  if (markdown !== '' && process.env.GITHUB_STEP_SUMMARY) {
    await core.summary.addRaw(markdown).addEOL().write()
  }

  if (commentOnPr && markdown !== '') {
    await upsertPullRequestComment(markdown, githubToken)
  }

  if (exitCode !== 0) {
    core.setFailed(
      stderr.trim() || `Schema drift check failed (fail_on=${failOn})`
    )
  }
}

async function run() {
  try {
    const version = core.getInput('version').trim()
    const pbufToken = core.getInput('pbuf_token')

    if (version === '') {
      core.setFailed('You must provide a version')
      return
    }
    if (!VERSION_RE.test(version)) {
      core.setFailed(`Invalid version "${version}"`)
      return
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
      await exec.exec('pbuf', ['auth', pbufToken])
    }

    core.info('Successfully setup pbuf cli')

    if (core.getInput('drift_diff').trim().toLowerCase() === 'true') {
      await runDriftDiff()
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

module.exports = {
  COMMENT_MARKER,
  run
}
