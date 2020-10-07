const { ESLint } = require('eslint')
const path = require('path')
const objectAssignDeep = require('object-assign-deep')

const BOT_NAME = 'sidekick-lint-bot'
const ESLINTRC = '.eslintrc.json'

const eslintConfigByRef = {}
const optionalConfigByDir = {}

/**
 * @param {String} patchString
 * @returns {Array}
 */
function getCommentPositionMap(patchString) {
  let commentPosition = 0
  let fileLinePosition = 0
  if (!patchString)
    return []
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
 * @param {String} path
 * @param {String} ref
 * @returns {String} file content
 */
async function getRepoFile(context, path, ref) {
  const params = context.repo({ path })
  if (ref)
    Object.assign(params, { ref })
  const response = await context.github.repos.getContent(params)
  return Buffer.from(response.data.content, 'base64').toString()
}

/**
 * @param {Object} context
 * @param {String} path
 * @param {String} ref
 */
async function getRepoJson(context, path, ref) {
  const json = await getRepoFile(context, path, ref)
  return JSON.parse(json)
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
 * @param {Object} config
 * @param {Object} localConfig
 * @return {Object}
 */
function mergeConfig(config, localConfig) {
  if (localConfig.root)
    return localConfig
  else 
    return objectAssignDeep(config, localConfig)
}

/**
 * @param {Object} context
 * @param {String} filename
 * @param {String} ref
 */
async function getOptionalConfig(context, filename, ref) {
  const dirs = path.dirname(filename).split('/')
  let config = {}
  let pathname = ''
  while (dirs.length > 0) {
    if (pathname !== '') pathname += '/'
    pathname += dirs.shift()
    const refDir = `${pathname}:${ref}`
    let localConfig = optionalConfigByDir[refDir]
    if (!localConfig) {
      const eslintrc = decodeURIComponent(`${pathname}/${ESLINTRC}`)
      try {
        localConfig = await getRepoJson(context, eslintrc, ref)
      } catch (e) {
        localConfig = {}
      }
      optionalConfigByDir[refDir] = localConfig
    }
    config = mergeConfig(config, localConfig)
  }
  return config
}

/**
 * @param {Object} context
 * @param {Object} optConfig
 * @param {String} ref
 */
async function initESLint(context, optConfig, ref) {
  let config = eslintConfigByRef[ref]
  if (!config) {
    try {
      config = await getRepoJson(context, ESLINTRC, ref)
      const prettierConfig = await getRepoJson(context, '.prettierrc', ref)
      if (config.plugins.indexOf('prettier') < 0) {
        config.plugins.push('prettier')
      }
      config.rules['prettier/prettier'] = ['error', prettierConfig]
    } catch (e) {
      config = {}
    }
    eslintConfigByRef[ref] = config
  }
  return new ESLint({
    overrideConfig: mergeConfig(config, optConfig),
    useEslintrc: false,
  })
}

/**
 * @param {Object} context
 */
async function lint(context) {
  const { action, pull_request: pullRequest, repository } = context.payload

  if (pullRequest.state !== 'open' || pullRequest.draft || pullRequest.merged) return

  const { base, head, number } = pullRequest
  const [owner, repo] = repository.full_name.split('/')
  console.log('Lint PR:', number)

  const ACTION_OPENED = 'opened'
  const ref1 = action === ACTION_OPENED ? base.sha : context.payload.before
  const ref2 = action === ACTION_OPENED ? head.sha : context.payload.after
  const compare = await context.github.repos.compareCommits(
    context.repo({ base: ref1, head: ref2, }))

  const { files } = compare.data
  const data = await Promise.all(files
    .filter(f => f.status !== 'removed')
    .filter(({ filename }) => filename.match(/.*.js$/))
    .map(async (file) => {
      const content = await getRepoFile(context, file.filename, head.sha)
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
  for (patch of data) {
    const optConfig = await getOptionalConfig(context, patch.filename, head.sha)
    const eslint = await initESLint(context, optConfig, head.sha)
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
  }

  console.log('comments:', comments)
  if (comments.length === 0)
    return

  // Avoid duplicates
  const oldComments = await getOldBotComments(context, owner, repo, number)
  const newComments = comments.filter(comment =>
    !oldComments.some(old =>
      old.position === comment.position &&
      old.path === comment.path &&
      old.body === comment.body))

  console.log('newComments:', newComments)
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
