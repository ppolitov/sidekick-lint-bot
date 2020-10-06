const { ESLint } = require('eslint')

const BOT_NAME = 'sidekick-lint-bot'

let eslintByContext = {}

/**
 * @param {String} patchString
 * @returns {Array}
 */
function getCommentPositionMap(patchString) {
  let commentPosition = 0
  let fileLinePosition = 0
  return patchString.split('\n').reduce((prev, line) => {
    commentPosition += 1
    if (line.match(/^@@(.*)@@/)) {
      fileLinePosition = line.match(/\+[0-9]+/)[0].replace('+', '') - 1
      commentPosition -= 1 // can not comment on lines with '@@ -, + @@'.
    } else if (!line.startsWith('-')) {
      fileLinePosition += 1
      if (line.startsWith('+')) {
        prev[fileLinePosition] = commentPosition // eslint-disable-line
      }
    }
    return prev
  }, {})
}

/**
 * Read file from a repository
 * @param {Object} context
 * @param {String} file
 * @param {Object=} options
 * @returns {String} file content
 */
async function getRepoFile(context, path, options) {
  const params = context.repo({ path })
  if (options)
    Object.assign(params, options)
  const response = await context.github.repos.getContent(params)
  return Buffer.from(response.data.content, 'base64').toString()
}

/**
 * @param {Object} context
 * @param {String} owner
 * @param {String} repo
 * @param {number} number
 * @returns {Array<Object>}
 */
async function getOldBotComments(context, owner, repo, number) {
  let oldComments = []
  const { data } = await context.github.pulls.listReviews(
    {owner, repo, pull_number: number})
  await Promise.all(data.map(async (review) => {
    if (review.user.login.indexOf(BOT_NAME) === 0) {
      const { data } = await context.github.pulls.listCommentsForReview(
        {owner, repo, pull_number: number, review_id: review.id})
      oldComments.push(...data)
    }
  }))
  return oldComments
}

/**
 * @param {Object} context
 */
async function initESLint(context) {
  if (!eslintByContext[context.id]) {
    const json = await getRepoFile(context, '.eslintrc.json')
    const config = JSON.parse(json)

    const prettierrc = await getRepoFile(context, '.prettierrc')
    const prettierConfig = JSON.parse(prettierrc)
    if (config.plugins.indexOf('prettier') < 0) {
      config.plugins.push('prettier')
    }
    config.rules['prettier/prettier'] = ['error', prettierConfig]

    eslintByContext[context.id] = new ESLint({
      overrideConfig: config,
      useEslintrc: false,
    })
  }
  return eslintByContext[context.id]
}

/**
 * @param {Object} context
 */
async function lint(context) {
  const { action, pull_request: pullRequest, repository } = context.payload

  if (pullRequest.state !== 'open' || pullRequest.draft || pullRequest.merged)
    return

  const { base, head, number } = pullRequest
  const [owner, repo] = repository.full_name.split('/')

  const ACTION_OPENED = 'opened'
  const ref1 = action === ACTION_OPENED ? base.sha : context.payload.before
  const ref2 = action === ACTION_OPENED ? head.sha : context.payload.after
  const compare = await context.github.repos.compareCommits(
    context.repo({ base: ref1, head: ref2, }))

  const { files } = compare.data
  const data = await Promise.all(files
    .filter(f => f.status !== 'removed')
    .filter(({ filename }) => filename.match(/.*(.js|.jsx)$/))
    .map(async (file) => {
      const content = await getRepoFile(context, file.filename, {
        owner,
        repo,
        path: file.filename,
        ref: head.sha
      })
      return {
        filename: file.filename,
        lineMap: getCommentPositionMap(file.patch),
        content,
      }
    }))
  
  if (data.length === 0)
    return

  // Find linter errors
  const comments = []
  const eslint = await initESLint(context)
  await Promise.all(data.map(async (patch) => {
    const results = await eslint.lintText(patch.content, {filePath: patch.filename})
    const eslintErrors = results[0].messages
    const errorsByLine = eslintErrors.reduce((lines, error) => {
      if (!lines[error.line]) lines[error.line] = []
      lines[error.line].push(error)
      return lines
    }, {})

    comments.push(...Object.keys(errorsByLine)
      .sort()
      .map(line => ({
        path: patch.filename,
        position: patch.lineMap[line],
        body: errorsByLine[line]
          .map(error => `**${error.ruleId}**: ${error.message}`)
          .join('\n'),
      })))
  }))

  if (comments.length === 0)
    return

  // Avoid duplicates
  const oldComments = await getOldBotComments(context, owner, repo, number)
  const newComments = comments.filter(comment =>
    !oldComments.some(old =>
      old.position === comment.position &&
      old.path === comment.path &&
      old.body === comment.body))

  // Post review comments
  if (newComments.length > 0) {
    await context.github.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      event: 'REQUEST_CHANGES',
      comments: newComments,
      body: 'ESLint found some errors.',
    })
  }
}

/**
 * @param {import('probot').Application} app
 */
module.exports = (app) => {
  app.on('pull_request.opened', lint)
  app.on('pull_request.synchronize', lint)
}
