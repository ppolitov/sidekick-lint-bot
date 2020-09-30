const { CLIEngine } = require('eslint')

const jsFileFilter = ({ filename }) => filename.match(/.*(.js|.jsx)$/)

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
  const data = await context.github.repos.getContent(params)
  return Buffer.from(data.content, 'base64').toString()
}

/**
 * @param {Object} context
 */
async function lint(context) {
  const config = JSON.parse(await getRepoFile(context, '.eslintrc.json'))
  const eslint = new CLIEngine({
    baseConfig: config,
    envs: ['es2020'],
    useEslintrc: false,
  })

  const { action, pull_request: pullRequest, repository } = context.payload
  const { base, head, number } = pullRequest
  const [owner, repo] = repository.full_name.split('/')

  const compare = await context.github.repos.compareCommits(context.repo({
    base: base.sha,
    head: head.sha,
  }))

  const { files } = compare.data
  const data = await Promise.all(files.filter(f => f.status !== 'removed').filter(jsFileFilter).map(async (file) => {
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
    comments.push(...eslintErrors.filter(error => data.lineMap[error.line] && error.severity === 2).map(error => ({
      path: data.filename,
      position: data.lineMap[error.line],
      body: `**${error.ruleId}**: ${error.message}`,
    })))
  })
  console.log('Comments:', comments)

  /*
  if (comments.length > 0) {
    await context.github.pullRequests.createReview({
      owner,
      repo,
      number,
      comments,
      event: 'REQUEST_CHANGES',
      body: 'ESLint found some errors. Please fix them and try committing again.',
    })
  } */
}

/**
 * @param {import('probot').Application} app
 */
module.exports = (app) => {
  app.log.info('Yay, the app was loaded!')
  app.on('pull_request.opened', lint)
  app.on('pull_request.synchronize', lint)
}
