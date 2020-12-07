const nock = require('nock');
// Requiring our app implementation
const myProbotApp = require('..');
const { Probot, ProbotOctokit } = require('probot');
// Requiring our fixtures
const payload = require('./fixtures/issues.opened');
const issueCreatedBody = { body: 'Thanks for opening this issue!' };
const fs = require('fs');
const path = require('path');

const privateKey = fs.readFileSync(
  path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

describe('My Probot app', () => {
  let probot

  beforeEach(() => {
    nock.disableNetConnect()
    probot = new Probot({
      id: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false }
      })
    })
    // Load our app into probot
    probot.load(myProbotApp)
  })

  test('creates a comment when an issue is opened', async () => {
    const mock = nock('https://api.github.com')
      .post('/app/installations/2/access_tokens')
      .reply(200, {token: 'test', permissions: {issues: 'write'}})
      .post('/repos/pushplaylabs/sidekick-ext-main/pull/1', (body) => {
        expect(body).toMatchObject(issueCreatedBody)
        return true
      })
      .reply(200)

    // Receive a webhook event
    await probot.receive({name: 'pull_request.opened', payload})

    expect(mock.pendingMocks()).toStrictEqual([])
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })
})
