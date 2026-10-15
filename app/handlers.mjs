// Webhook handlers. `ghFor(installationId, repo)` returns a light-core client ({ get, write }) for that repo.
import { CHECK_NAME, lightFromWorkflowRuns, checkOutput } from './light.mjs';
import { goLive as pagesGoLive } from '../src/pages.mjs';

const ZERO = /^0{40}$/;
export const GO_LIVE = {
  label: 'Go live',
  identifier: 'go-live',
  description: 'Point the Pages root at this lit commit',
};

export function createHandlers({
  appId,
  ghFor,
  tokenFor,
  goLive = pagesGoLive,
  log = console.log,
  now = () => new Date(),
}) {
  async function ownCheck(gh, repo, sha) {
    const q = `check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${appId}&filter=latest`;
    const { check_runs: runs = [] } = await gh.get(`/repos/${repo}/commits/${sha}/check-runs?${q}`);
    return runs.find((c) => c.app?.id === Number(appId) && c.name === CHECK_NAME) ?? null;
  }

  // Create the check if this commit has none, then set it from the workflow runs.
  async function evaluate(installationId, repo, sha) {
    const gh = await ghFor(installationId, repo);
    let check = await ownCheck(gh, repo, sha);
    const { workflow_runs: runs = [] } = await gh.get(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
    const result = lightFromWorkflowRuns(runs);
    const done = result.state === 'lit' || result.state === 'dark';
    const body = {
      ...(done
        ? {
            status: 'completed',
            conclusion: result.state === 'lit' ? 'success' : 'failure',
            completed_at: now().toISOString(),
          }
        : { status: 'in_progress' }),
      output: checkOutput(result),
      actions: result.state === 'lit' ? [GO_LIVE] : [],
    };
    if (!check)
      check = await gh.write('POST', `/repos/${repo}/check-runs`, { name: CHECK_NAME, head_sha: sha, ...body });
    else await gh.write('PATCH', `/repos/${repo}/check-runs/${check.id}`, body);
    log(`${repo}@${sha.slice(0, 7)}: ${result.state}`);
    return { state: result.state, checkId: check.id };
  }

  async function goLiveFromCheck(payload) {
    const repo = payload.repository.full_name;
    const installationId = payload.installation.id;
    const gh = await ghFor(installationId, repo);
    const refuse = async (checkId, why) => {
      log(`${repo}: go-live refused: ${why}`);
      await gh.write('PATCH', `/repos/${repo}/check-runs/${checkId}`, {
        output: { title: '○ go-live refused', summary: `${why}\n\nNothing changed.` },
      });
      return { live: false, reason: why };
    };
    const id = payload.check_run.id;
    // re-read the check from GitHub: the trusted light is this app's own completed commit-live check
    const check = await gh.get(`/repos/${repo}/check-runs/${id}`);
    if (check.app?.id !== Number(appId) || check.name !== CHECK_NAME)
      return { live: false, reason: 'not this app’s commit-live check' };
    const sha = check.head_sha;
    if (check.status !== 'completed' || check.conclusion !== 'success')
      return refuse(id, `${sha} is not lit (${check.conclusion ?? check.status}). Only a lit commit can go live.`);
    const latest = await ownCheck(gh, repo, sha);
    if (!latest || latest.id !== id)
      return refuse(id, 'a newer commit-live check exists for this commit; use that one.');
    const login = payload.sender?.login;
    const perm = await gh.get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`).catch(() => null);
    if (!perm || !['admin', 'maintain', 'write'].includes(perm.permission))
      return refuse(id, `@${login} needs write access to make a commit live.`);
    const pages = await gh.get(`/repos/${repo}/pages`).catch(() => null);
    const [owner, name] = repo.split('/');
    const url = (pages?.html_url ?? `https://${owner}.github.io/${name}/`).replace(/\/?$/, '/');
    try {
      const token = await tokenFor(installationId);
      await goLive({
        remote: `https://github.com/${repo}.git`,
        token,
        sha,
        meta: { light: 'lit', bit: 0, check: check.html_url, by: login, at: now().toISOString() },
      });
    } catch (e) {
      return refuse(id, `go-live failed: ${e.message}`);
    }
    await gh.write('PATCH', `/repos/${repo}/check-runs/${id}`, {
      output: {
        title: '● lit and live',
        summary: `${url} now serves \`${sha}\` (made live by @${login}). Preview: ${url}c/${sha}/`,
      },
    });
    log(`${repo}: ${sha} is live`);
    return { live: true, sha, url };
  }

  return {
    evaluate,
    goLiveFromCheck,
    async handle(event, payload) {
      const repo = payload.repository?.full_name;
      const installationId = payload.installation?.id;
      if (!repo || !installationId) return { ignored: 'no repository or installation' };
      if (event === 'push') {
        if (payload.deleted || ZERO.test(payload.after ?? '')) return { ignored: 'branch deleted' };
        return evaluate(installationId, repo, payload.after);
      }
      if (event === 'pull_request') {
        if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) return { ignored: payload.action };
        return evaluate(installationId, repo, payload.pull_request.head.sha);
      }
      if (event === 'workflow_run') {
        if (payload.action !== 'completed' && payload.action !== 'in_progress') return { ignored: payload.action };
        return evaluate(installationId, repo, payload.workflow_run.head_sha);
      }
      if (event === 'check_run' && payload.check_run?.app?.id === Number(appId)) {
        if (payload.action === 'rerequested') return evaluate(installationId, repo, payload.check_run.head_sha);
        if (payload.action === 'requested_action' && payload.requested_action?.identifier === GO_LIVE.identifier)
          return goLiveFromCheck(payload);
      }
      return { ignored: event };
    },
  };
}
