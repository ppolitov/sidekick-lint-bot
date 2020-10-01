const { CLIEngine } = require('eslint')

const BOT_NAME = 'sidekick-lint-bot'

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
  if (response.status === 200) {
    return Buffer.from(response.data.content, 'base64').toString()
  }
  return ''
}

/**
 * @param {Object} context
 * @param {String} owner
 * @param {String} repo
 * @param {number} number
 */
async function removeOldReview(context, owner, repo, number) {
  const { data } = await context.github.pulls.listReviews(
    {owner, repo, pull_number: number})
  data.forEach(async (review) => {
    if (review.user.login.indexOf(BOT_NAME) === 0) {
      await context.github.pulls.dismissReview(
        {owner, repo, pull_number: number, review_id: review.id, message: 'Outdated.'})
    }
  })
}

/**
 * @param {Object} context
 */
async function lint(context) {
  const json = await getRepoFile(context, '.eslintrc.json')
  const config = json !== '' ? JSON.parse(json) : {}
  const eslint = new CLIEngine({
    baseConfig: config,
    envs: ['es2020'],
    useEslintrc: false,
  })

  const { pull_request: pullRequest, repository } = context.payload
  const { base, head, number } = pullRequest
  const [owner, repo] = repository.full_name.split('/')

  const compare = await context.github.repos.compareCommits(context.repo({
    base: base.sha,
    head: head.sha,
  }))

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

  const comments = []
  data.forEach((data) => {
    const { results: [result] } = eslint.executeOnText(data.content, data.filename)
    const eslintErrors = result.messages
    comments.push(...eslintErrors
      .map(error => ({
        path: data.filename,
        position: data.lineMap[error.line],
        body: `**${error.ruleId}**: ${error.message}`,
      })))
  })

  if (comments.length > 0) {
    //await removeOldReview(context, owner, repo, number)

    await context.github.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      event: 'REQUEST_CHANGES',
      comments,
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
