import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInputs, context, check, goLiveMode } from '../src/main.mjs';
import { MARKER } from '../src/comment.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ctx = (extra = {}) => ({
  repo: 'o/r',
  sha: A,
  pr: null,
  fromFork: false,
  runUrl: 'https://github.com/o/r/actions/runs/1',
  remote: 'r',
  defaultPagesUrl: 'https://o.github.io/r/',
  ...extra,
});
const inputs = (extra = {}) => ({ ...readInputs({}), ...extra });
function fakeGh({ statuses = [], comments = [] } = {}) {
  const writes = [];
  return {
    writes,
    get: async (p) => {
      if (p.includes('/statuses')) return statuses;
      if (p.includes('/comments')) return comments;
      if (/\/commits\/[0-9a-f]+$/.test(p)) return { sha: A };
      throw new Error(p);
    },
    write: async (m, p, b) => {
      writes.push([m, p, b]);
      return {};
    },
  };
}
const quiet = () => {};

test('inputs and defaults', () => {
  const i = readInputs({ INPUT_TEST_COMMAND: 'make test', INPUT_BUILD_DIR: 'site', GITHUB_TOKEN: 't' });
  assert.deepEqual(
    [i.mode, i.testCommand, i.buildDir, i.preview, i.pagesBranch, i.token, i.failOnDark],
    ['check', 'make test', 'site', 'lit', 'gh-pages', 't', true],
  );
});

test('a PR light belongs to the head sha', () => {
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'merge', GITHUB_EVENT_PATH: 'e', GITHUB_RUN_ID: '9' };
  const c = context(env, () => ({ pull_request: { number: 4, head: { sha: B, repo: { full_name: 'o/r' } } } }));
  assert.deepEqual([c.sha, c.pr, c.fromFork, c.defaultPagesUrl], [B, 4, false, 'https://o.github.io/r/']);
  const f = context(env, () => ({ pull_request: { number: 4, head: { sha: B, repo: { full_name: 'x/r' } } } }));
  assert.equal(f.fromFork, true);
  assert.equal(
    context({ ...env, GITHUB_REPOSITORY: 'o/o.github.io' }, () => ({})).defaultPagesUrl,
    'https://o.github.io/',
  );
});

test('lit commit: preview deployed, status success with the preview link, PR comment', async () => {
  const gh = fakeGh();
  const published = [];
  const code = await check({
    inputs: inputs({ buildDir: 'site' }),
    ctx: ctx({ pr: 7 }),
    gh,
    env: {},
    log: quiet,
    run: () => ({ exitCode: 0, light: 'lit' }),
    publish: async (o) => published.push(o),
  });
  assert.equal(code, 0);
  assert.equal(published[0].sha, A);
  const [, path, status] = gh.writes[0];
  assert.equal(path, `/repos/o/r/statuses/${A}`);
  assert.deepEqual([status.state, status.target_url], ['success', `https://o.github.io/r/c/${A}/`]);
  const [m, p, c] = gh.writes[1];
  assert.equal(m, 'POST');
  assert.equal(p, '/repos/o/r/issues/7/comments');
  assert.ok(c.body.startsWith(MARKER));
  assert.match(c.body, /● lit/);
});

test('dark commit: no preview, status failure, job dark', async () => {
  const gh = fakeGh();
  let published = 0;
  const code = await check({
    inputs: inputs({ buildDir: 'site' }),
    ctx: ctx(),
    gh,
    env: {},
    log: quiet,
    run: () => ({ exitCode: 1, light: 'dark' }),
    publish: async () => published++,
  });
  assert.equal(code, 1);
  assert.equal(published, 0);
  assert.equal(gh.writes[0][2].state, 'failure');
  assert.equal(gh.writes.length, 1, 'no comment outside a PR');
});

test('the PR comment is updated in place', async () => {
  const gh = fakeGh({
    comments: [
      { id: 3, body: 'hi' },
      { id: 5, body: `${MARKER}\nold` },
    ],
  });
  await check({
    inputs: inputs(),
    ctx: ctx({ pr: 7 }),
    gh,
    env: {},
    log: quiet,
    run: () => ({ exitCode: 0, light: 'lit' }),
  });
  assert.deepEqual(gh.writes[1].slice(0, 2), ['PATCH', '/repos/o/r/issues/comments/5']);
});

test('a preview that fails to deploy is an error; the light stays lit', async () => {
  const gh = fakeGh();
  const code = await check({
    inputs: inputs({ buildDir: 'site' }),
    ctx: ctx(),
    gh,
    env: {},
    log: quiet,
    run: () => ({ exitCode: 0, light: 'lit' }),
    publish: async () => {
      throw new Error('push refused');
    },
  });
  assert.equal(code, 2);
  assert.equal(gh.writes[0][2].state, 'success');
});

test('fork PRs get a status but no preview or comment', async () => {
  const gh = fakeGh();
  let published = 0;
  await check({
    inputs: inputs({ buildDir: 'site' }),
    ctx: ctx({ pr: 7, fromFork: true }),
    gh,
    env: {},
    log: quiet,
    run: () => ({ exitCode: 0, light: 'lit' }),
    publish: async () => published++,
  });
  assert.equal(published, 0);
  assert.equal(gh.writes.length, 1);
});

const status = (state) => [{ context: 'commit-live', state, created_at: '2026-10-15T00:00:00Z' }];

test('go-live refuses a dark commit and changes nothing', async () => {
  const gh = fakeGh({ statuses: status('failure') });
  let went = 0;
  assert.equal(
    await goLiveMode({
      inputs: inputs({ mode: 'go-live', sha: A }),
      ctx: ctx(),
      gh,
      env: {},
      log: quiet,
      live: async () => went++,
    }),
    1,
  );
  assert.equal(went, 0);
  assert.equal(gh.writes.length, 0);
});

test('go-live refuses a commit with no light', async () => {
  for (const statuses of [[], status('pending')]) {
    let went = 0;
    const gh = fakeGh({ statuses });
    assert.equal(
      await goLiveMode({
        inputs: inputs({ mode: 'go-live', sha: A }),
        ctx: ctx(),
        gh,
        env: {},
        log: quiet,
        live: async () => went++,
      }),
      1,
    );
    assert.equal(went, 0);
  }
});

test('go-live on a lit commit flips the root and marks it live', async () => {
  const gh = fakeGh({ statuses: status('success') });
  const calls = [];
  const code = await goLiveMode({
    inputs: inputs({ mode: 'go-live', sha: 'aaaaaaa' }),
    ctx: ctx(),
    gh,
    env: {},
    log: quiet,
    live: async (o) => {
      calls.push(o);
      return { changed: true };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls[0].sha, A, 'short sha resolved');
  assert.deepEqual(gh.writes[0].slice(0, 2), ['POST', `/repos/o/r/statuses/${A}`]);
  assert.equal(gh.writes[0][2].context, 'commit-live/live');
});

test('go-live needs a sha', async () => {
  await assert.rejects(
    goLiveMode({ inputs: inputs({ mode: 'go-live' }), ctx: ctx(), gh: fakeGh(), env: {}, log: quiet }),
    /needs the sha/,
  );
  await assert.rejects(
    goLiveMode({ inputs: inputs({ mode: 'go-live', sha: 'main' }), ctx: ctx(), gh: fakeGh(), env: {}, log: quiet }),
    /must be a commit sha/,
  );
});
