const core = require('@actions/core')
const github = require('@actions/github')

async function run() {
  try {
    const token = core.getInput('token');
    const { payload } = github.context;
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    //const [owner, repo] = payload.repository.full_name.split('/')

    const octokit = github.getOctokit(token);
    const { data: pulls } = await octokit.pulls.list({owner, repo});
    console.log(`owner: ${owner} repo: ${repo}`);
    console.log('pull:', JSON.stringify(pulls[0], null, 2));
  } catch (error) {
    core.setFailed(error.message);
  }
}

run()
